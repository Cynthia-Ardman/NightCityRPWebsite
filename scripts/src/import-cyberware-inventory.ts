// Imports the cyberware roster spreadsheet into `inventory_items` rows
// (category='cyberware') so the dashboard's chrome-count band logic and the
// weekly cyberpsychosis-meds projection see the actual installed implants.
//
// Reads BOTH "Character CWP Tracking" (PCs) and "NPC CWP Tracking" (NPCs)
// sheets out of the v2 cyberware list. Each implant row becomes one
// inventory_items row tagged with a sentinel marker in `notes` so the import
// is idempotent: on rerun we delete only rows we previously inserted (matched
// by that sentinel) before re-inserting, leaving ripperdoc-installed chrome
// and other manually added items untouched.
//
// PC matching: case-insensitive exact match on characters.name where kind='pc'.
// PCs that are not found are logged and skipped (we never auto-create PCs —
// they have to be claimed through the normal sheet flow).
// NPC matching: same as the existing import-npcs-cyberware.ts — exact name on
// kind='npc'; missing NPCs are created with claimed=false, ownerId=null.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db, pool, characters, inventoryItems } from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");

const DEFAULT_FILE = "NCRP__Cyberware_list_v2(1)_1779978749744.xlsx";
const FILE = process.env.CYBERWARE_FILE ?? DEFAULT_FILE;

// Sentinel embedded in inventory_items.notes so reruns can find and delete
// only the rows this importer wrote, leaving manually/ripperdoc-installed
// chrome untouched. Bump the version if the row shape ever changes.
const SENTINEL = "[cyberware-import:v1]";

type Row = (string | number | null)[];

type Implant = {
  name: string;
  cwp: string | null;
  brand: string | null;
  brandTier: string | null;
  fn: string | null;
  slot: string | null;
  notes: string | null;
};

type CharBlock = {
  name: string;
  playerName: string | null;
  cwpTotal: string | null;
  implants: Implant[];
};

function loadSheet(file: string, sheetName: string): Row[] {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found in ${file}`);
  return XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, defval: null });
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

// Both sheets share the same column layout — Character | Player Name |
// CWP Total | Implant Name | CWP | Brand | Brand Tier | Function | Slot/Type
// | Notes. Each character's block starts with a row that has a non-null
// Character cell; subsequent rows with only an implant name are appended to
// the current block.
function parseBlocks(sheetName: string): CharBlock[] {
  const rows = loadSheet(FILE, sheetName);
  const blocks: CharBlock[] = [];
  let cur: CharBlock | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const character = str(r[0]);
    const player = str(r[1]);
    const cwpTotal = str(r[2]);
    const implantName = str(r[3]);
    if (character) {
      cur = { name: character, playerName: player, cwpTotal, implants: [] };
      blocks.push(cur);
    }
    if (cur && implantName) {
      cur.implants.push({
        name: implantName,
        cwp: str(r[4]),
        brand: str(r[5]),
        brandTier: str(r[6]),
        fn: str(r[7]),
        slot: str(r[8]),
        notes: str(r[9]),
      });
    }
  }
  return blocks;
}

function formatNotes(im: Implant): string {
  // Pack the implant metadata into the notes field so it stays visible in the
  // inventory tab. Trailing SENTINEL is what we grep for on rerun.
  const parts: string[] = [];
  if (im.cwp) parts.push(`CWP ${im.cwp}`);
  if (im.slot) parts.push(im.slot);
  if (im.brand) parts.push(im.brand + (im.brandTier ? ` (${im.brandTier})` : ""));
  if (im.fn) parts.push(im.fn);
  if (im.notes) parts.push(im.notes);
  const head = parts.join(" · ");
  return head ? `${head} ${SENTINEL}` : SENTINEL;
}

type PcLookup = { kind: "ok"; id: number } | { kind: "missing" } | { kind: "ambiguous"; ids: number[] };

async function findPcId(name: string): Promise<PcLookup> {
  // Case-insensitive exact match. There's no unique (kind,name) constraint, so
  // we must check for duplicates explicitly — picking arbitrarily would risk
  // attaching implants to the wrong player's character and corrupting their
  // wallet/billing/transfer history. On ambiguity we skip and log.
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM characters
    WHERE kind = 'pc' AND lower(name) = lower(${name})
    ORDER BY id ASC
  `);
  if (rows.rows.length === 0) return { kind: "missing" };
  if (rows.rows.length > 1) return { kind: "ambiguous", ids: rows.rows.map((r) => r.id) };
  return { kind: "ok", id: rows.rows[0].id };
}

async function findOrCreateNpcId(name: string, playerName: string | null): Promise<number> {
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM characters WHERE kind = 'npc' AND name = ${name} LIMIT 1
  `);
  if (rows.rows[0]) return rows.rows[0].id;
  const [created] = await db.insert(characters).values({
    name,
    kind: "npc",
    claimed: false,
    ownerId: null,
    legacyDiscordUsername: playerName,
    archetype: null,
    lifeStatus: "active",
    approved: true,
  }).returning({ id: characters.id });
  return created.id;
}

async function applyBlock(characterId: number, block: CharBlock): Promise<{ deleted: number; inserted: number }> {
  // Wrap delete+insert in a transaction so a crash between the two doesn't
  // leave the character with zero cyberware mid-rerun (which would briefly
  // wrong-band their meds bill).
  return await db.transaction(async (tx) => {
    const del = await tx.execute(sql`
      DELETE FROM inventory_items
      WHERE character_id = ${characterId}
        AND category = 'cyberware'
        AND notes LIKE ${'%' + SENTINEL + '%'}
    `);
    const deleted = del.rowCount ?? 0;

    if (block.implants.length === 0) return { deleted, inserted: 0 };

    await tx.insert(inventoryItems).values(
      block.implants.map((im) => ({
        characterId,
        name: im.name,
        category: "cyberware",
        quantity: 1,
        notes: formatNotes(im),
        equipped: true,
      })),
    );
    return { deleted, inserted: block.implants.length };
  });
}

async function main() {
  console.log(`Reading ${FILE}`);
  const pcBlocks = parseBlocks("Character CWP Tracking");
  const npcBlocks = parseBlocks("NPC CWP Tracking");
  console.log(`Parsed PCs: ${pcBlocks.length} blocks (${pcBlocks.reduce((a, b) => a + b.implants.length, 0)} implants)`);
  console.log(`Parsed NPCs: ${npcBlocks.length} blocks (${npcBlocks.reduce((a, b) => a + b.implants.length, 0)} implants)`);

  let pcMatched = 0, pcMissing = 0, pcAmbiguous = 0, pcInserted = 0, pcDeleted = 0;
  const missing: string[] = [];
  const ambiguous: string[] = [];
  for (const block of pcBlocks) {
    if (block.implants.length === 0) continue;
    const hit = await findPcId(block.name);
    if (hit.kind === "missing") {
      pcMissing++;
      missing.push(`${block.name}${block.playerName ? ` (${block.playerName})` : ""}`);
      continue;
    }
    if (hit.kind === "ambiguous") {
      pcAmbiguous++;
      ambiguous.push(`${block.name}${block.playerName ? ` (${block.playerName})` : ""} → ids [${hit.ids.join(", ")}]`);
      continue;
    }
    const r = await applyBlock(hit.id, block);
    pcMatched++;
    pcInserted += r.inserted;
    pcDeleted += r.deleted;
    if (process.env.VERBOSE) console.log(`  PC ${block.name} (#${hit.id}): -${r.deleted} +${r.inserted}`);
  }

  let npcTouched = 0, npcInserted = 0, npcDeleted = 0;
  for (const block of npcBlocks) {
    if (block.implants.length === 0) continue;
    const id = await findOrCreateNpcId(block.name, block.playerName);
    const r = await applyBlock(id, block);
    npcTouched++;
    npcInserted += r.inserted;
    npcDeleted += r.deleted;
    if (process.env.VERBOSE) console.log(`  NPC ${block.name} (#${id}): -${r.deleted} +${r.inserted}`);
  }

  console.log("\n=== Summary ===");
  console.log(`PCs matched: ${pcMatched}  (replaced ${pcDeleted}, inserted ${pcInserted} implants)`);
  console.log(`PCs not found: ${pcMissing}`);
  if (missing.length) {
    console.log("Missing PCs (no matching character row by name):");
    for (const m of missing) console.log(`  - ${m}`);
  }
  console.log(`PCs skipped (ambiguous — multiple matches by name): ${pcAmbiguous}`);
  if (ambiguous.length) {
    console.log("Ambiguous PCs (need manual disambiguation before importing):");
    for (const a of ambiguous) console.log(`  - ${a}`);
  }
  console.log(`NPCs touched: ${npcTouched}  (replaced ${npcDeleted}, inserted ${npcInserted} implants)`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
