/**
 * Apply character sheet import to PROD.
 *
 * Reads scripts/output/character-sheets-preview.json (already scraped from
 * Discord + image-classified), rehosts each image from Discord CDN to PROD
 * object storage via the live nightcityroleplay.com API, and upserts rows
 * into the prod database.
 *
 * Idempotent:
 *   - Matches existing prod rows by (ownerId, lower(name)) and merges in
 *     place rather than inserting duplicates.
 *   - Skips characters that already have a portrait_url + sheet_data.
 *   - Never clobbers an admin-assigned ownerId on rerun.
 *
 * Required env:
 *   DATABASE_URL  must point at the prod database (PROD_DATABASE_URL).
 *
 * Optional:
 *   API_BASE              defaults to https://nightcityroleplay.com
 *   REHOST_CONCURRENCY    defaults to 4
 *   DRY_RUN=1             skip writes, just print what would happen
 *   LIMIT=<n>             only process first n records
 *   SKIP_FILLED=1         skip records whose prod row already has portrait+sheet
 *
 * Usage:
 *   DATABASE_URL="$PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/scripts exec tsx src/apply-prod-import.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { db, characters, users, characterStatus } from "@workspace/db";
import { eq, sql } from "drizzle-orm";

const PREVIEW_PATH = resolve(
  import.meta.dirname,
  "..",
  "output",
  "character-sheets-preview.json",
);
const API_BASE = process.env.API_BASE ?? "https://nightcityroleplay.com";
const REHOST_CONCURRENCY = Number(process.env.REHOST_CONCURRENCY ?? "4");
const DRY_RUN = process.env.DRY_RUN === "1";
const LIMIT = process.env.LIMIT ? Number(process.env.LIMIT) : Infinity;
const SKIP_FILLED = process.env.SKIP_FILLED === "1";

// Sanity check: confirm we're pointed at prod.
const dbUrl = process.env.DATABASE_URL ?? "";
const isProdLike = dbUrl.includes("neon") || dbUrl.includes("prod") || /pg.*replit/.test(dbUrl);
console.log(`DATABASE_URL host hint: ${dbUrl.replace(/:[^@]+@/, ":***@").split("@")[1]?.split("/")[0] ?? "(unknown)"}`);
console.log(`API_BASE: ${API_BASE}`);
console.log(`DRY_RUN: ${DRY_RUN}`);
if (!DRY_RUN && !isProdLike) {
  console.warn(
    "WARNING: DATABASE_URL doesn't look like a prod URL. If this is intentional, ignore.",
  );
}

type ImgKind = "stats" | "portrait" | "other" | "unclassified";
type ImageRecord = {
  url: string;
  proxyUrl?: string;
  filename: string;
  fromMessageId: string;
  kind: ImgKind;
};
type ThreadRecord = {
  threadId: string;
  threadTitle: string;
  sourceChannelId: string;
  sourceChannelName: string;
  archived: boolean;
  parsedName: string;
  parsedUsername: string | null;
  resolvedDiscordId: string | null;
  resolvedDisplayName: string | null;
  posterUsername: string;
  sheet: { preamble: string; sections: Record<string, string> } | null;
  images: ImageRecord[];
  warnings: string[];
};

const allRecords = JSON.parse(readFileSync(PREVIEW_PATH, "utf8")) as ThreadRecord[];
const records = allRecords.slice(0, LIMIT);
console.log(`Loaded ${allRecords.length} records from preview (processing ${records.length}).`);

async function pMapBounded<T, R>(
  items: T[],
  fn: (item: T, idx: number) => Promise<R>,
  concurrency: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return out;
}

async function rehostImage(url: string, filename: string): Promise<string | null> {
  try {
    const dlCtl = new AbortController();
    const dlTimer = setTimeout(() => dlCtl.abort(), 20_000);
    let buf: Buffer;
    let contentType: string;
    try {
      const r = await fetch(url, { signal: dlCtl.signal });
      if (!r.ok) return null;
      contentType = r.headers.get("content-type") ?? "image/png";
      buf = Buffer.from(await r.arrayBuffer());
    } finally {
      clearTimeout(dlTimer);
    }
    if (buf.length === 0) return null;
    if (DRY_RUN) return `/api/storage/objects/DRY_RUN_${filename}`;
    const reqRes = await fetch(`${API_BASE}/api/storage/uploads/request-url`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: filename, size: buf.length, contentType }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!reqRes.ok) {
      console.warn(`  request-url ${reqRes.status} for ${filename}`);
      return null;
    }
    const { uploadURL, objectPath } = (await reqRes.json()) as {
      uploadURL: string;
      objectPath: string;
    };
    const putRes = await fetch(uploadURL, {
      method: "PUT",
      headers: { "Content-Type": contentType },
      body: buf,
      signal: AbortSignal.timeout(60_000),
    });
    if (!putRes.ok) {
      console.warn(`  PUT ${putRes.status} for ${filename}`);
      return null;
    }
    return objectPath;
  } catch (err) {
    console.warn(`  rehost error for ${filename}: ${(err as Error).message}`);
    return null;
  }
}

let applied = 0;
let skipped = 0;
let mergedInPlace = 0;
let inserted = 0;
let imagesUploaded = 0;

for (const r of records) {
  const sectionCount = r.sheet ? Object.keys(r.sheet.sections).length : 0;
  const hasContent =
    sectionCount > 0 || (r.sheet?.preamble?.length ?? 0) > 0 || r.images.length > 0;
  if (!hasContent) {
    skipped++;
    continue;
  }

  // Owner: link to existing user, or create placeholder; null if unclaimed.
  let ownerId: string | null = null;
  if (r.resolvedDiscordId) {
    const [existingUser] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.discordId, r.resolvedDiscordId));
    if (existingUser) {
      ownerId = existingUser.id;
    } else if (!DRY_RUN) {
      await db
        .insert(users)
        .values({
          id: r.resolvedDiscordId,
          discordId: r.resolvedDiscordId,
          username: r.parsedUsername ?? r.resolvedDisplayName ?? "unknown",
          globalName: r.resolvedDisplayName,
        })
        .onConflictDoNothing();
      ownerId = r.resolvedDiscordId;
    } else {
      ownerId = r.resolvedDiscordId;
    }
  }

  const nameForMatch = r.parsedName.slice(0, 64);

  // Look up existing prod row by (ownerId, name) to skip-or-merge.
  let existing:
    | {
        id: number;
        portraitUrl: string | null;
        portraitUrls: string[] | null;
        statsImageUrls: string[] | null;
        sheetData: unknown;
      }
    | undefined;
  if (ownerId) {
    const dupes = await db
      .select({
        id: characters.id,
        importedFromThreadId: characters.importedFromThreadId,
        portraitUrl: characters.portraitUrl,
        portraitUrls: characters.portraitUrls,
        statsImageUrls: characters.statsImageUrls,
        sheetData: characters.sheetData,
      })
      .from(characters)
      .where(
        sql`${characters.ownerId} = ${ownerId} and lower(${characters.name}) = lower(${nameForMatch})`,
      );
    // Prefer the legacy prod-import row (no thread id) for merge target.
    existing =
      dupes.find((d) => !d.importedFromThreadId) ??
      dupes.find((d) => d.importedFromThreadId === r.threadId);
  }

  if (
    SKIP_FILLED &&
    existing &&
    existing.portraitUrl &&
    existing.sheetData &&
    (existing.portraitUrls?.length ?? 0) > 0
  ) {
    skipped++;
    continue;
  }

  // Rehost images (skip if existing row already has them).
  const portraits = r.images.filter((i) => i.kind === "portrait");
  const statsImgs = r.images.filter((i) => i.kind === "stats");
  const portraitUrls: string[] = [];
  const statsImageUrls: string[] = [];

  const needPortraits = !existing?.portraitUrls?.length;
  const needStats = !existing?.statsImageUrls?.length;

  if (needPortraits) {
    await pMapBounded(
      portraits,
      async (img) => {
        const p = await rehostImage(img.url, img.filename);
        if (p) {
          portraitUrls.push(p);
          imagesUploaded++;
        }
      },
      REHOST_CONCURRENCY,
    );
  }
  if (needStats) {
    await pMapBounded(
      statsImgs,
      async (img) => {
        const p = await rehostImage(img.url, img.filename);
        if (p) {
          statsImageUrls.push(p);
          imagesUploaded++;
        }
      },
      REHOST_CONCURRENCY,
    );
  }

  const primaryPortrait = portraitUrls[0] ?? null;

  const sections = r.sheet?.sections ?? {};
  const archetype =
    (sections["Occupation"] ??
      sections["Occupation / Role in Night City"] ??
      "")
      .split(/\r?\n/)[0]
      ?.trim()
      .slice(0, 200) || null;
  const background =
    (
      sections["Backstory"] ??
      sections["Psychological Profile"] ??
      r.sheet?.preamble ??
      null
    )
      ?.toString()
      .trim()
      .slice(0, 8000) || null;

  const isRetired = r.sourceChannelName.toLowerCase().includes("retired");

  const values = {
    ownerId,
    claimed: ownerId !== null,
    legacyDiscordUsername: r.parsedUsername,
    name: nameForMatch,
    kind: "pc" as const,
    archetype,
    background,
    portraitUrl: primaryPortrait,
    portraitUrls,
    statsImageUrls,
    sheetData: r.sheet,
    importedFromThreadId: r.threadId,
    importedFromChannelName: r.sourceChannelName,
    discordChannelId: r.threadId,
    approved: true,
    archived: isRetired,
    archivedAt: isRetired ? new Date() : null,
  };

  if (DRY_RUN) {
    applied++;
    console.log(
      `  [dry] ${r.parsedName.padEnd(28)} owner=${ownerId ?? "—"} sections=${sectionCount} p=${portraitUrls.length} s=${statsImageUrls.length} existing=${existing ? "yes" : "no"}`,
    );
    continue;
  }

  let insertedRow: { id: number } | undefined;
  if (existing) {
    const mergedPortraitUrls =
      existing.portraitUrls && existing.portraitUrls.length > 0
        ? existing.portraitUrls
        : portraitUrls;
    const mergedStatsUrls =
      existing.statsImageUrls && existing.statsImageUrls.length > 0
        ? existing.statsImageUrls
        : statsImageUrls;
    const [u] = await db
      .update(characters)
      .set({
        legacyDiscordUsername: values.legacyDiscordUsername,
        archetype: values.archetype,
        background: values.background,
        portraitUrl: existing.portraitUrl ?? values.portraitUrl,
        portraitUrls: mergedPortraitUrls,
        statsImageUrls: mergedStatsUrls,
        sheetData: values.sheetData,
        importedFromThreadId: values.importedFromThreadId,
        importedFromChannelName: values.importedFromChannelName,
        discordChannelId: values.discordChannelId,
        archived: values.archived,
        kind: values.kind,
        approved: true,
      })
      .where(eq(characters.id, existing.id))
      .returning({ id: characters.id });
    insertedRow = u;
    mergedInPlace++;
  } else {
    const [u] = await db
      .insert(characters)
      .values(values)
      .onConflictDoUpdate({
        target: characters.importedFromThreadId,
        set: {
          ownerId: sql`coalesce(${characters.ownerId}, excluded.owner_id)`,
          claimed: sql`(${characters.ownerId} is not null) or excluded.claimed`,
          legacyDiscordUsername: values.legacyDiscordUsername,
          name: values.name,
          archetype: values.archetype,
          background: values.background,
          portraitUrl: sql`coalesce(${characters.portraitUrl}, excluded.portrait_url)`,
          portraitUrls: sql`case when array_length(${characters.portraitUrls}, 1) is null or array_length(${characters.portraitUrls}, 1) = 0 then excluded.portrait_urls else ${characters.portraitUrls} end`,
          statsImageUrls: sql`case when array_length(${characters.statsImageUrls}, 1) is null or array_length(${characters.statsImageUrls}, 1) = 0 then excluded.stats_image_urls else ${characters.statsImageUrls} end`,
          sheetData: values.sheetData,
          importedFromChannelName: values.importedFromChannelName,
          archived: values.archived,
        },
      })
      .returning({ id: characters.id });
    insertedRow = u;
    inserted++;
  }

  if (insertedRow) {
    await db
      .insert(characterStatus)
      .values({ characterId: insertedRow.id })
      .onConflictDoNothing();
  }

  applied++;
  if (applied % 10 === 0) {
    console.log(
      `  progress: ${applied}/${records.length} (merged ${mergedInPlace}, inserted ${inserted}, images ${imagesUploaded})`,
    );
  }
}

console.log(
  `\nDone. applied=${applied} merged=${mergedInPlace} inserted=${inserted} skipped=${skipped} images=${imagesUploaded}`,
);
process.exit(0);
