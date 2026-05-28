import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { and, eq, sql } from "drizzle-orm";
import {
  db,
  pool,
  catalogRent,
  housing,
  users,
  characters,
} from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");

const RENT_FILE = "NCRP_Rent_and_Leases(1)_1780005155491.xlsx";

type Row = (string | number | null)[];

function loadAllSheets(file: string): { name: string; rows: Row[] }[] {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const wb = XLSX.read(buf, { type: "buffer" });
  return wb.SheetNames.map((sn) => ({
    name: sn,
    rows: XLSX.utils.sheet_to_json<Row>(wb.Sheets[sn]!, { header: 1, defval: null }),
  }));
}

function toInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  const m = String(v).match(/-?\d[\d,]*/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s;
}

function normName(s: string): string {
  // Strip smart quotes, nicknames in quotes, extra spaces; lowercase.
  return s
    .replace(/[\u201C\u201D\u2018\u2019"']/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

type ParsedRow = {
  district: string;
  tier: string;
  kind: "residential" | "business";
  listingName: string;
  description: string | null;
  monthlyRent: number;
  ownerDiscordId: string | null;
  ownerCharacterName: string | null;
};

function parseSheet(district: string, rows: Row[]): ParsedRow[] {
  const out: ParsedRow[] = [];
  let tier: string | null = null;
  let building: string | null = null;
  let businessName: string | null = null;
  let businessOpCost: string | number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const tierCell = str(r[0]);
    const buildingCell = str(r[2]);
    const businessCell = str(r[3]);
    const opCostCell = r[4];
    const roomCell = str(r[5]);
    const rent = toInt(r[6]);
    const ownerCell = str(r[7]);
    const charNameCell = str(r[8]);
    const userIdCell = str(r[9]);

    if (tierCell) {
      // Normalize "Buisness" typo.
      tier = tierCell.replace(/Buisness/i, "Business");
      // New tier block resets building/business context.
      building = null;
      businessName = null;
    }
    if (buildingCell) building = buildingCell;
    if (businessCell) businessName = businessCell;
    // Op-cost is row-local — not all units in a multi-row building share the
    // same operating cost. Reset every row and only use the literal cell.
    businessOpCost =
      opCostCell !== null && opCostCell !== undefined && opCostCell !== ""
        ? (opCostCell as string | number)
        : null;

    if (rent === null) continue;
    if (!tier) continue;
    const isBusiness = /business/i.test(tier);
    const kind: "residential" | "business" = isBusiness ? "business" : "residential";

    // Listing name strategy:
    //   business: prefer Business name, fall back to Building (+ Room if any).
    //   residential: Building - Room (or Building alone if only one unit).
    let listingName: string;
    if (isBusiness) {
      const base = businessName ?? building;
      if (!base) continue;
      listingName = roomCell && roomCell.toLowerCase() !== "main"
        ? `${base} (${roomCell})`
        : base;
    } else {
      if (!building && !roomCell) continue;
      const room = roomCell ? String(roomCell) : null;
      listingName = building
        ? room
          ? `${building} #${room}`
          : building
        : `Apartment #${room}`;
    }

    const descParts: string[] = [];
    if (isBusiness && building && businessName && building !== businessName) {
      descParts.push(`Building: ${building}`);
    }
    if (typeof businessOpCost === "number") {
      descParts.push(`Operating cost: €$${businessOpCost.toLocaleString()}/mo`);
    } else if (typeof businessOpCost === "string" && businessOpCost.trim()) {
      descParts.push(businessOpCost.trim());
    }

    const isVacant =
      !ownerCell ||
      /^vacant$/i.test(ownerCell) ||
      (charNameCell && /^vacant$/i.test(charNameCell)) ||
      (userIdCell && /^vacant$/i.test(userIdCell));

    out.push({
      district,
      tier,
      kind,
      listingName,
      description: descParts.length ? descParts.join(" • ") : null,
      monthlyRent: rent,
      ownerDiscordId: isVacant ? null : userIdCell && /^\d{10,25}$/.test(userIdCell) ? userIdCell : null,
      ownerCharacterName: isVacant ? null : charNameCell,
    });
  }
  return out;
}

async function upsertListing(p: ParsedRow): Promise<number> {
  // Match by (name, district) — those together are unique enough.
  const existing = await db
    .select({ id: catalogRent.id })
    .from(catalogRent)
    .where(and(eq(catalogRent.name, p.listingName), eq(catalogRent.district, p.district)))
    .limit(1);
  if (existing.length) {
    const id = existing[0].id;
    await db
      .update(catalogRent)
      .set({
        tier: p.tier,
        monthlyRent: p.monthlyRent,
        description: p.description,
      })
      .where(eq(catalogRent.id, id));
    return id;
  }
  const inserted = await db
    .insert(catalogRent)
    .values({
      name: p.listingName,
      district: p.district,
      tier: p.tier,
      monthlyRent: p.monthlyRent,
      description: p.description,
    })
    .returning({ id: catalogRent.id });
  return inserted[0].id;
}

async function findCharacterFor(
  discordId: string,
  desiredName: string | null,
): Promise<{ id: number; userId: string; name: string } | null> {
  // Look up the user.
  const u = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.discordId, discordId))
    .limit(1);
  if (!u.length) return null;
  const userId = u[0].id;
  // Fetch all characters owned by this user.
  const owned = await db
    .select({ id: characters.id, name: characters.name, approved: characters.approved, archived: characters.archived })
    .from(characters)
    .where(eq(characters.ownerId, userId));
  if (!owned.length) return null;
  // Prefer approved + non-archived.
  const active = owned.filter((c) => !c.archived);
  const approved = active.filter((c) => c.approved);
  const pool = approved.length ? approved : active.length ? active : owned;
  if (desiredName) {
    const target = normName(desiredName);
    // Exact (normalized) match only — substring matching can false-link
    // characters whose names share a token (e.g. "Adam" vs "Adam Smith").
    const exact = pool.find((c) => normName(c.name) === target);
    if (exact) return { ...exact, userId };
  }
  // Fall back to the single active char only when unambiguous.
  if (pool.length === 1) return { ...pool[0], userId };
  // Multiple chars and no exact name match — refuse to guess.
  return null;
}

async function upsertLease(
  listingId: number,
  characterId: number,
  address: string,
  monthlyRent: number,
  kind: "residential" | "business",
): Promise<"created" | "updated"> {
  const existing = await db
    .select({ id: housing.id })
    .from(housing)
    .where(and(eq(housing.listingId, listingId), eq(housing.characterId, characterId)))
    .limit(1);
  if (existing.length) {
    await db
      .update(housing)
      .set({ address, monthlyRent, kind })
      .where(eq(housing.id, existing[0].id));
    return "updated";
  }
  await db.insert(housing).values({
    listingId,
    characterId,
    address,
    monthlyRent,
    kind,
  });
  return "created";
}

async function main() {
  console.log(`\nReading ${RENT_FILE}...`);
  const sheets = loadAllSheets(RENT_FILE);
  console.log(`  sheets: ${sheets.map((s) => s.name).join(", ")}`);

  const parsed: ParsedRow[] = [];
  for (const s of sheets) {
    const rows = parseSheet(s.name, s.rows);
    console.log(`  ${s.name}: ${rows.length} listings (${rows.filter((r) => r.ownerDiscordId).length} occupied)`);
    parsed.push(...rows);
  }

  const counts = {
    listings: 0,
    leasesCreated: 0,
    leasesUpdated: 0,
    leasesRemoved: 0,
    skippedNoUser: 0,
    skippedNoChar: 0,
  };
  const skipped: string[] = [];

  for (const p of parsed) {
    const listingId = await upsertListing(p);
    counts.listings++;

    // Vacancy reconciliation: the spreadsheet is the source of truth, so a
    // listing now marked Vacant must have any leftover lease(s) removed.
    if (!p.ownerDiscordId) {
      const removed = await db
        .delete(housing)
        .where(eq(housing.listingId, listingId))
        .returning({ id: housing.id });
      counts.leasesRemoved += removed.length;
      continue;
    }
    const char = await findCharacterFor(p.ownerDiscordId, p.ownerCharacterName);
    if (!char) {
      // Try to distinguish "no user" vs "user has no char".
      const u = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.discordId, p.ownerDiscordId))
        .limit(1);
      if (!u.length) {
        counts.skippedNoUser++;
        skipped.push(`  [no user] ${p.listingName} <- discord:${p.ownerDiscordId} (${p.ownerCharacterName ?? "?"})`);
      } else {
        counts.skippedNoChar++;
        skipped.push(`  [no char] ${p.listingName} <- user:${u[0].id} discord:${p.ownerDiscordId} (wanted "${p.ownerCharacterName ?? "?"}")`);
      }
      continue;
    }
    // Tenant-change reconciliation: drop any existing lease on this
    // listing that belongs to a *different* character before we upsert.
    const stale = await db
      .delete(housing)
      .where(and(eq(housing.listingId, listingId), sql`${housing.characterId} <> ${char.id}`))
      .returning({ id: housing.id });
    counts.leasesRemoved += stale.length;

    const result = await upsertLease(listingId, char.id, p.listingName, p.monthlyRent, p.kind);
    if (result === "created") counts.leasesCreated++;
    else counts.leasesUpdated++;
  }

  console.log("\nDone:");
  console.log(`  listings upserted: ${counts.listings}`);
  console.log(`  leases created:    ${counts.leasesCreated}`);
  console.log(`  leases updated:    ${counts.leasesUpdated}`);
  console.log(`  leases removed:    ${counts.leasesRemoved}`);
  console.log(`  skipped (no user): ${counts.skippedNoUser}`);
  console.log(`  skipped (no char): ${counts.skippedNoChar}`);
  if (skipped.length) {
    console.log("\nSkipped rows:");
    for (const s of skipped) console.log(s);
  }

  // Sanity check: how many rows are now in each table?
  const lc = await db.execute(sql`select count(*)::int as n from catalog_rent`);
  const hc = await db.execute(sql`select count(*)::int as n from housing`);
  console.log(`\nTotals after import: catalog_rent=${(lc.rows[0] as { n: number }).n}  housing=${(hc.rows[0] as { n: number }).n}`);
}

main()
  .catch((err) => {
    console.error("Import failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
