/**
 * Character Archive cleanup (idempotent, id-agnostic).
 *
 * Two operations:
 *   1. STRIP the raw `<!--cyberware-import-start--> … <!--cyberware-import-end-->`
 *      HTML-comment blocks out of `characters.background` (they render as
 *      literal text under the BACKSTORY heading). Trims the result; a row
 *      whose background was ONLY the block becomes NULL.
 *   2. MERGE duplicate character rows created by re-imports:
 *        a) same owner_id + identical name  → keep the richest row, delete
 *           the others — but ONLY when each loser is an empty stub (no
 *           real content) AND has NO attached gameplay data. Otherwise the
 *           pair is REPORTED for human review and left untouched.
 *        b) the specific Wallie⇄Wallow pair (different names, same NPC per
 *           the project owner) — same empty-stub + no-attached-data guards.
 *      Same-name rows owned by DIFFERENT users (e.g. two "Bones") are NOT
 *      duplicates and are left alone (reported only).
 *
 * Safety:
 *   - DEFAULTS TO DRY-RUN. Pass --apply to actually write.
 *   - Never deletes a row that has any row in a table referencing
 *     characters.id (FK cascade tables) or any non-FK *_character_id column.
 *   - Prints the (masked) target host so you can confirm dev vs live.
 *
 * Run against the LIVE prod DB:
 *   DATABASE_URL="$LIVE_PROD_DATABASE_URL" \
 *     pnpm --filter @workspace/scripts exec tsx src/cleanup-character-archive.ts --apply
 *   (omit --apply for a dry run first)
 */
import { pool } from "@workspace/db";

const APPLY = process.argv.includes("--apply");

const CW_RE = "<!--cyberware-import-start-->.*?<!--cyberware-import-end-->";

type Row = {
  id: number;
  name: string;
  owner_id: string | null;
  claimed: boolean;
  archived: boolean;
  kind: string;
  archetype: string | null;
  portrait_url: string | null;
  portrait_urls: string[] | null;
  stats_image_urls: string[] | null;
  sheet_data: unknown | null;
  background: string | null;
  legacy_discord_username: string | null;
  imported_from_thread_id: string | null;
};

// FK tables whose character_id references characters.id (ON DELETE CASCADE).
const FK_TABLES = [
  "character_updates",
  "character_status",
  "inventory_items",
  "wallet_transactions",
  "store_employees",
  "ripperdoc_employees",
  "housing",
  "housing_requests",
  "trauma_team_calls",
  "mission_log",
  "pending_character_edits",
  "shop_opens",
];
// Non-FK integer columns that point at a character id (would dangle on delete).
const DANGLING: Array<[string, string]> = [
  ["users", "active_character_id"],
  ["inventory_events", "from_character_id"],
  ["inventory_events", "to_character_id"],
  ["wallet_transactions", "counterparty_character_id"],
  ["stores", "owner_character_id"],
  ["ripperdocs", "owner_character_id"],
  ["character_sheets", "character_id"],
  ["dice_rolls", "character_id"],
];

function maskedHost(): string {
  const url = process.env.DATABASE_URL ?? "";
  try {
    return new URL(url.replace(/^postgres(ql)?:\/\//, "https://")).hostname;
  } catch {
    return "(unparsed)";
  }
}

function cleanBackground(bg: string | null): string {
  if (!bg) return "";
  return bg
    .replace(new RegExp(CW_RE, "gs"), "")
    .replace(/\[legacy:[^\]]+\]/g, "")
    .replace(/\[legacy-mission:[^\]]+\]/g, "")
    .trim();
}

function isEmptyStub(r: Row): boolean {
  return (
    cleanBackground(r.background).length === 0 &&
    !r.portrait_url &&
    (r.portrait_urls?.length ?? 0) === 0 &&
    (r.stats_image_urls?.length ?? 0) === 0 &&
    r.sheet_data == null
  );
}

// Richness ranking — higher is "keep". Tuple compared left-to-right.
function richness(r: Row): number[] {
  return [
    r.sheet_data != null ? 1 : 0,
    r.portrait_url || (r.portrait_urls?.length ?? 0) > 0 ? 1 : 0,
    r.stats_image_urls?.length ?? 0,
    cleanBackground(r.background).length,
    -r.id, // tiebreak: prefer lower id
  ];
}
function cmpRich(a: Row, b: Row): number {
  const ra = richness(a);
  const rb = richness(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return rb[i] - ra[i]; // descending
  }
  return 0;
}

async function attachedDataCount(id: number): Promise<Record<string, number>> {
  const hits: Record<string, number> = {};
  for (const t of FK_TABLES) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE character_id = $1`,
      [id],
    );
    if (rows[0].n > 0) hits[t] = rows[0].n;
  }
  for (const [t, c] of DANGLING) {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${t} WHERE ${c} = $1`,
      [id],
    );
    if (rows[0].n > 0) hits[`${t}.${c}`] = rows[0].n;
  }
  return hits;
}

async function deleteRow(id: number): Promise<void> {
  await pool.query(`DELETE FROM characters WHERE id = $1`, [id]);
}

// Tables we know how to safely re-point from a loser to the survivor (no
// UNIQUE/PK constraint on character_id that could collide). inventory_items
// is the only attached data observed; anything else is reported, not guessed.
const MIGRATABLE = new Set(["inventory_items"]);

// Move a loser's child rows onto the survivor. Returns the list of tables
// with attached data we do NOT know how to migrate safely; if non-empty the
// caller must skip the merge and leave it for human review.
async function migrateChildRows(
  survivorId: number,
  finalOwnerId: string | null,
  loserId: number,
): Promise<string[]> {
  const attached = await attachedDataCount(loserId);
  const unhandled = Object.keys(attached).filter((t) => !MIGRATABLE.has(t));
  if (unhandled.length) return unhandled;
  if (attached["inventory_items"]) {
    console.log(
      `[migrate] re-point ${attached["inventory_items"]} inventory_items #${loserId} -> #${survivorId}`,
    );
    if (APPLY) {
      await pool.query(
        `UPDATE inventory_items
           SET character_id = $1, owner_id = COALESCE($2, owner_id)
         WHERE character_id = $3`,
        [survivorId, finalOwnerId, loserId],
      );
    }
  }
  return [];
}

async function main() {
  console.log(`Target host: ${maskedHost()}`);
  console.log(`Mode: ${APPLY ? "APPLY (writing)" : "DRY-RUN (no writes)"}\n`);

  // ---- 1) Strip cyberware blocks --------------------------------------
  const { rows: cwRows } = await pool.query<{ id: number }>(
    `SELECT id FROM characters WHERE background ILIKE '%cyberware-import-start%'`,
  );
  console.log(`[strip] ${cwRows.length} backstories contain a cyberware-import block`);
  if (APPLY && cwRows.length > 0) {
    const res = await pool.query(
      `UPDATE characters
         SET background = NULLIF(btrim(regexp_replace(background, $1, '', 'g')), '')
       WHERE background ILIKE '%cyberware-import-start%'`,
      [CW_RE],
    );
    console.log(`[strip] stripped ${res.rowCount} rows`);
  }

  // ---- Load all characters for duplicate analysis ---------------------
  const { rows: all } = await pool.query<Row>(`
    SELECT id, name, owner_id, claimed, archived, kind, archetype,
           portrait_url, portrait_urls, stats_image_urls, sheet_data,
           background, legacy_discord_username, imported_from_thread_id
    FROM characters`);

  const norm = (s: string) => s.toLowerCase().trim();

  // ---- 2a) same owner + identical name --------------------------------
  const groups = new Map<string, Row[]>();
  for (const r of all) {
    if (!r.owner_id) continue;
    const k = `${r.owner_id}::${norm(r.name)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  let mergedCount = 0;
  const review: string[] = [];

  for (const [, rows] of groups) {
    if (rows.length < 2) continue;
    const sorted = [...rows].sort(cmpRich);
    const survivor = sorted[0];
    const losers = sorted.slice(1);
    for (const lo of losers) {
      if (!isEmptyStub(lo)) {
        review.push(
          `  same-owner dup NOT merged: keep #${survivor.id} "${survivor.name}", ` +
            `loser #${lo.id} has real content (background/portrait/sheet)`,
        );
        continue;
      }
      const unhandled = await migrateChildRows(survivor.id, survivor.owner_id, lo.id);
      if (unhandled.length) {
        review.push(
          `  same-owner dup NOT merged: keep #${survivor.id} "${survivor.name}", ` +
            `loser #${lo.id} has un-migratable data in ${unhandled.join(", ")}`,
        );
        continue;
      }
      console.log(
        `[merge] "${survivor.name}" (owner ${survivor.owner_id}): ` +
          `keep #${survivor.id}, delete stub #${lo.id}`,
      );
      if (APPLY) await deleteRow(lo.id);
      mergedCount++;
    }
  }

  // ---- 2b) Wallie ⇄ Wallow (different names, same NPC) -----------------
  const wallie = all.filter((r) => /wallie/i.test(r.name));
  const wallow = all.filter((r) => /wallow/i.test(r.name));
  if (wallie.length === 1 && wallow.length === 1) {
    const stub = wallie[0]; // the cyberware-only stub
    const rich = wallow[0]; // the full sheet
    const finalOwner = rich.owner_id ?? stub.owner_id;
    if (!isEmptyStub(stub)) {
      review.push(
        `  Wallie⇄Wallow NOT merged: stub #${stub.id} has real content (background/portrait/sheet)`,
      );
    } else {
      const unhandled = await migrateChildRows(rich.id, finalOwner, stub.id);
      if (unhandled.length) {
        review.push(
          `  Wallie⇄Wallow NOT merged: stub #${stub.id} has un-migratable data in ${unhandled.join(", ")}`,
        );
      } else {
        console.log(
          `[merge] Wallie⇄Wallow: keep #${rich.id} "${rich.name}", ` +
            `delete stub #${stub.id} "${stub.name}", transfer owner ${stub.owner_id}`,
        );
        if (APPLY) {
          await pool.query(
            `UPDATE characters
               SET owner_id = COALESCE(owner_id, $2),
                   claimed = claimed OR $3,
                   legacy_discord_username = COALESCE(legacy_discord_username, $4)
             WHERE id = $1`,
            [rich.id, stub.owner_id, stub.claimed, stub.legacy_discord_username],
          );
          await deleteRow(stub.id);
        }
        mergedCount++;
      }
    }
  } else if (wallie.length || wallow.length) {
    review.push(
      `  Wallie/Wallow shape unexpected: wallie=${wallie.length} wallow=${wallow.length} — left untouched`,
    );
  }

  // ---- Report same-name DIFFERENT-owner pairs (left separate) ---------
  const byName = new Map<string, Row[]>();
  for (const r of all) {
    const k = norm(r.name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k)!.push(r);
  }
  for (const [, rows] of byName) {
    if (rows.length < 2) continue;
    const owners = new Set(rows.map((r) => r.owner_id ?? "(none)"));
    if (owners.size > 1) {
      review.push(
        `  same name DIFFERENT owners (left separate): ` +
          rows.map((r) => `#${r.id} owner=${r.owner_id ?? "(none)"}`).join(", ") +
          ` — "${rows[0].name}"`,
      );
    }
  }

  console.log(`\nMerges ${APPLY ? "applied" : "planned"}: ${mergedCount}`);
  if (review.length) {
    console.log(`\nLeft for review / untouched (${review.length}):`);
    for (const r of review) console.log(r);
  }

  await pool.end();
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
