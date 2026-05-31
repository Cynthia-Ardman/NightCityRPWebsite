/**
 * Ripperdoc importer.
 *
 * Populates the `ripperdocs` table from the legacy source so the Ripperdoc
 * directory is no longer empty. Reads the legacy source (read-only) and writes
 * into DATABASE_URL.
 *
 *   pnpm --filter @workspace/scripts run import-ripperdocs
 *
 * Design — source-specific mapping is isolated:
 *   The legacy NightCityBot has no dedicated ripperdoc table. Its ripperdoc
 *   shops live as a JSON map under `cw_shop_state.settings.ripperdoc_stores`,
 *   keyed "rd:<guild_id>:<owner_discord_id>" with { owner_id, store_name,
 *   employees }. `loadSourceRipperdocs()` reads that out of PROD_DATABASE_URL
 *   and normalizes each entry into a `SourceRipperdoc`. Everything below the
 *   mapping layer is source-agnostic — point `loadSourceRipperdocs()` at a
 *   different source (spreadsheet, JSON file, another table) and nothing else
 *   needs to change.
 *
 * Idempotency:
 *   Each row is stamped with `[legacy-ripperdoc:<legacyId>]` in its
 *   `description` (same convention as import-prod's `[legacy-store:...]`).
 *   Reruns upsert by that tag instead of duplicating. The user-facing display
 *   scrub of these import codes is owned by a separate task.
 *
 * Owner resolution:
 *   The legacy owner discord id is resolved to an existing `users` row by
 *   `discord_id`. `ripperdocs.owner_id` is NOT NULL, so a ripperdoc whose
 *   owner does not resolve is REPORTED and SKIPPED, never inserted — we never
 *   auto-create users. Such rows import cleanly on a later rerun once the owner
 *   exists (e.g. after they log in). On rerun, an already-imported row keeps
 *   its existing owner (so an admin reassignment is never clobbered); only the
 *   descriptive fields are refreshed from the source.
 *
 * Conventions: bulk-load in a few set-based queries (no per-row remote loops)
 * and force process exit on error so the script can't hang silently.
 */
import pg from "pg";
import { eq, sql } from "drizzle-orm";
import { db, pool, ripperdocs, users, characters, auditLog } from "@workspace/db";

// Human-readable label for the active source, recorded in the audit entry.
const SOURCE_LABEL = "legacy:cw_shop_state.ripperdoc_stores";

const legacyTag = (id: string) => `[legacy-ripperdoc:${id}]`;

// Normalized, source-agnostic ripperdoc record. The mapping layer produces
// these; the importer consumes them.
type SourceRipperdoc = {
  legacyId: string; // stable idempotency key
  name: string;
  ownerDiscordId: string | null;
  location: string | null;
  purpose: string | null;
  description: string | null; // human description (the legacy tag is added by the importer)
};

// ---------------------------------------------------------------------------
// SOURCE-SPECIFIC MAPPING — swap this function to point at a different source.
// ---------------------------------------------------------------------------
async function loadSourceRipperdocs(): Promise<SourceRipperdoc[]> {
  const PROD = process.env.PROD_DATABASE_URL;
  if (!PROD) throw new Error("PROD_DATABASE_URL not set (legacy ripperdoc source)");
  const prod = new pg.Client({ connectionString: PROD });
  await prod.connect();
  try {
    const r = await prod.query<{ settings: unknown }>(
      `SELECT settings FROM cw_shop_state LIMIT 1`,
    );
    const root = (r.rows[0]?.settings ?? {}) as Record<string, unknown>;
    // Tolerate both observed shapes: { ripperdoc_stores } and the nested
    // { settings: { ... }, ripperdoc_stores }.
    const nested = (root.settings ?? {}) as Record<string, unknown>;
    const map = (root.ripperdoc_stores ?? nested.ripperdoc_stores ?? {}) as Record<
      string,
      { owner_id?: number | string; store_name?: string; employees?: unknown[] }
    >;
    const out: SourceRipperdoc[] = [];
    for (const [key, raw] of Object.entries(map)) {
      // NOTE: the numeric `owner_id` field is precision-corrupted — Discord
      // snowflakes exceed JS's safe-integer range, so the stored JSON number is
      // rounded. The KEY preserves the full id: "rd:<guild>:<owner_discord>".
      // Always derive the owner from the key, never from owner_id.
      const parts = key.split(":");
      const ownerRaw = parts.length >= 3 ? parts[parts.length - 1] : null;
      const ownerDiscordId = ownerRaw && /^\d{10,25}$/.test(ownerRaw) ? ownerRaw : null;
      // Keep malformed rows (e.g. empty name): the importer classifies and
      // reports them as skips rather than the mapping silently dropping them.
      out.push({
        legacyId: key,
        name: String(raw?.store_name ?? "").trim(),
        ownerDiscordId,
        location: null,
        purpose: null,
        description: null,
      });
    }
    return out;
  } finally {
    await prod.end();
  }
}
// ---------------------------------------------------------------------------

// Safety guard: this script writes ripperdoc rows. Refuse to run against a
// non-dev DATABASE_URL unless the operator explicitly opts in with
// IMPORT_TARGET=prod (mirrors the cyberware importer guard).
function assertTargetDbAllowed(): void {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error("DATABASE_URL is not a valid URL");
  }
  const looksLikeDev = /helium|replit\.dev|replit\.com|localhost|127\.0\.0\.1/i.test(host);
  const target = process.env.IMPORT_TARGET;
  if (!looksLikeDev && target !== "prod") {
    console.error(
      `\nRefusing to write to ${host}: this does not look like the dev DB.\n` +
        `If you really mean to write to live prod, set IMPORT_TARGET=prod.\n`,
    );
    process.exit(2);
  }
  if (looksLikeDev && target === "prod") {
    console.error(
      `\nIMPORT_TARGET=prod was set but DATABASE_URL host (${host}) looks like the dev DB.\n`,
    );
    process.exit(2);
  }
  console.log(`Target DB host: ${host}  (mode: ${target === "prod" ? "PROD" : "DEV"})`);
}

async function main() {
  assertTargetDbAllowed();

  const sources = await loadSourceRipperdocs();
  console.log(`Loaded ${sources.length} ripperdoc(s) from ${SOURCE_LABEL}`);

  // Bulk-load local lookup tables once (no per-row queries).
  const userRows = await db
    .select({ id: users.id, discordId: users.discordId })
    .from(users);
  const userByDiscord = new Map(userRows.map((u) => [u.discordId, u.id]));

  const charRows = await db
    .select({
      id: characters.id,
      ownerId: characters.ownerId,
      approved: characters.approved,
      archived: characters.archived,
    })
    .from(characters);
  // Best character per owner: prefer non-archived, then approved, then lowest id.
  const ranked = charRows
    .filter((c) => c.ownerId)
    .sort(
      (a, b) =>
        Number(a.archived) - Number(b.archived) ||
        Number(b.approved) - Number(a.approved) ||
        a.id - b.id,
    );
  const ownerActiveChar = new Map<string, number>();
  for (const c of ranked) {
    if (!ownerActiveChar.has(c.ownerId!)) ownerActiveChar.set(c.ownerId!, c.id);
  }

  let created = 0;
  let updated = 0;
  const unresolved: string[] = [];
  const skipped: string[] = []; // non-owner skips (malformed source rows)
  const errors: string[] = [];

  for (const src of sources) {
    try {
      if (!src.name) {
        skipped.push(`(${src.legacyId}) — source row has no name`);
        continue;
      }
      const tag = legacyTag(src.legacyId);
      const description = [src.description, tag].filter(Boolean).join(" ").trim();

      // Tag-based lookup FIRST. An already-imported row is refreshed even when
      // its source owner no longer resolves (e.g. an admin reassigned the
      // owner, or the original owner left the server). Owner resolution only
      // gates INSERTing a brand-new row, since owner_id is NOT NULL.
      const existing = await db
        .select({ id: ripperdocs.id })
        .from(ripperdocs)
        .where(sql`${ripperdocs.description} LIKE ${"%" + tag + "%"}`)
        .limit(1);

      if (existing.length) {
        // Preserve the existing owner (never clobber an admin reassignment);
        // refresh only the descriptive fields from the source.
        await db
          .update(ripperdocs)
          .set({
            name: src.name,
            location: src.location,
            purpose: src.purpose,
            description,
          })
          .where(eq(ripperdocs.id, existing[0].id));
        updated++;
        continue;
      }

      // Brand-new row — an owner is required (owner_id is NOT NULL).
      if (!src.ownerDiscordId) {
        unresolved.push(`${src.name} — no owner id in source (${src.legacyId})`);
        continue;
      }
      const ownerId = userByDiscord.get(src.ownerDiscordId);
      if (!ownerId) {
        unresolved.push(
          `${src.name} — owner discord:${src.ownerDiscordId} has no portal user`,
        );
        continue;
      }
      const ownerCharacterId = ownerActiveChar.get(ownerId) ?? null;
      await db.insert(ripperdocs).values({
        ownerId,
        ownerCharacterId,
        name: src.name,
        location: src.location,
        purpose: src.purpose,
        description,
      });
      created++;
    } catch (err) {
      errors.push(
        `${src.name || src.legacyId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Audit entry summarizing the run.
  await db.insert(auditLog).values({
    category: "shop",
    action: "import_ripperdocs",
    actorId: null,
    actorName: "importer",
    targetType: "ripperdoc",
    message: `Ripperdoc import (${SOURCE_LABEL}): ${created} created, ${updated} updated, ${unresolved.length} unresolved, ${skipped.length} skipped, ${errors.length} errors of ${sources.length} source rows`,
    afterJson: {
      source: SOURCE_LABEL,
      total: sources.length,
      created,
      updated,
      unresolved,
      skipped,
      errors,
    },
  });

  console.log("\n=== Ripperdoc import summary ===");
  console.log(`  source rows:        ${sources.length}`);
  console.log(`  created:            ${created}`);
  console.log(`  updated:            ${updated}`);
  console.log(`  unresolved owners:  ${unresolved.length}`);
  console.log(`  skipped (malformed):${skipped.length}`);
  console.log(`  errors:             ${errors.length}`);
  if (unresolved.length) {
    console.log("\nUnresolved (skipped — owner not found):");
    for (const u of unresolved) console.log(`  - ${u}`);
  }
  if (skipped.length) {
    console.log("\nSkipped (malformed source rows):");
    for (const s of skipped) console.log(`  - ${s}`);
  }
  if (errors.length) {
    console.log("\nErrors:");
    for (const e of errors) console.log(`  - ${e}`);
  }

  const total = await db.execute(sql`SELECT count(*)::int AS n FROM ripperdocs`);
  console.log(`\nTotal ripperdocs in DB now: ${(total.rows[0] as { n: number }).n}`);
}

main()
  .then(async () => {
    await pool.end();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error("Import failed:", err);
    try {
      await pool.end();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
