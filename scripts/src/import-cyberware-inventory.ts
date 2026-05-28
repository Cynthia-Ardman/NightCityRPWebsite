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
// Matching policy:
//   1. cyberware-aliases.json (sheet name → DB id, or action='organic').
//   2. Fall back to case-insensitive exact match on characters.name.
//   3. If still no unique match, log and skip. We NEVER auto-create
//      characters — every sheet entry must map to an existing DB row or be
//      explicitly listed in the alias map.
//
// Organic handling: entries flagged action='organic' (or with no implants in
// the sheet and an explicit characterId) set characters.is_organic=true on
// the mapped row and skip the chrome insert entirely.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { sql, eq } from "drizzle-orm";
import { db, pool, characters, inventoryItems } from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");
const ALIAS_FILE = path.join(ROOT, "scripts", "cyberware-aliases.json");

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

type AliasEntry =
  | { action: "match"; characterId: number }
  | { action: "organic"; characterId?: number };

type AliasMap = { pc: Record<string, AliasEntry>; npc: Record<string, AliasEntry> };

function loadAliases(): AliasMap {
  if (!fs.existsSync(ALIAS_FILE)) return { pc: {}, npc: {} };
  const raw = JSON.parse(fs.readFileSync(ALIAS_FILE, "utf8")) as Partial<AliasMap> & { _comment?: unknown };
  return { pc: raw.pc ?? {}, npc: raw.npc ?? {} };
}

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
  const parts: string[] = [];
  if (im.cwp) parts.push(`CWP ${im.cwp}`);
  if (im.slot) parts.push(im.slot);
  if (im.brand) parts.push(im.brand + (im.brandTier ? ` (${im.brandTier})` : ""));
  if (im.fn) parts.push(im.fn);
  if (im.notes) parts.push(im.notes);
  const head = parts.join(" · ");
  return head ? `${head} ${SENTINEL}` : SENTINEL;
}

type Lookup = { kind: "ok"; id: number } | { kind: "missing" } | { kind: "ambiguous"; ids: number[] };

async function findByName(kind: "pc" | "npc", name: string): Promise<Lookup> {
  // Case-insensitive exact match. There's no unique (kind,name) constraint, so
  // we must check for duplicates explicitly — picking arbitrarily would risk
  // attaching implants to the wrong player's character.
  const rows = await db.execute<{ id: number }>(sql`
    SELECT id FROM characters
    WHERE kind = ${kind} AND lower(name) = lower(${name})
    ORDER BY id ASC
  `);
  if (rows.rows.length === 0) return { kind: "missing" };
  if (rows.rows.length > 1) return { kind: "ambiguous", ids: rows.rows.map((r) => r.id) };
  return { kind: "ok", id: rows.rows[0].id };
}

async function applyBlock(characterId: number, block: CharBlock): Promise<{ deleted: number; inserted: number }> {
  // Wrap delete+insert+is_organic update in a transaction so a crash between
  // them doesn't leave the character with zero cyberware mid-rerun (which
  // would briefly wrong-band their meds bill).
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
    // A character with chrome is definitionally not organic — clear the flag
    // if it was previously set (e.g. by a stale organic alias).
    await tx.update(characters).set({ isOrganic: false }).where(eq(characters.id, characterId));
    return { deleted, inserted: block.implants.length };
  });
}

async function markOrganic(characterId: number): Promise<{ deleted: number; conflict: boolean }> {
  // Set is_organic=true and remove any chrome rows this importer previously
  // inserted. If non-sentinel chrome still exists afterward (ripperdoc or
  // manual rows), flag a conflict so the operator can decide — we don't
  // silently nuke human-owned data.
  return await db.transaction(async (tx) => {
    const del = await tx.execute(sql`
      DELETE FROM inventory_items
      WHERE character_id = ${characterId}
        AND category = 'cyberware'
        AND notes LIKE ${'%' + SENTINEL + '%'}
    `);
    const left = await tx.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM inventory_items
      WHERE character_id = ${characterId} AND category = 'cyberware'
    `);
    const conflict = (left.rows[0]?.n ?? 0) > 0;
    if (!conflict) {
      await tx.update(characters).set({ isOrganic: true }).where(eq(characters.id, characterId));
    }
    return { deleted: del.rowCount ?? 0, conflict };
  });
}

async function validateAliasTarget(kind: "pc" | "npc", characterId: number): Promise<"ok" | "missing" | "wrong_kind"> {
  const rows = await db.execute<{ kind: string }>(sql`
    SELECT kind FROM characters WHERE id = ${characterId} LIMIT 1
  `);
  if (rows.rows.length === 0) return "missing";
  if (rows.rows[0].kind !== kind) return "wrong_kind";
  return "ok";
}

type Outcome =
  | { tag: "chrome"; id: number; inserted: number; deleted: number }
  | { tag: "organic"; id: number; deleted: number }
  | { tag: "organic_conflict"; id: number; deleted: number }
  | { tag: "missing" }
  | { tag: "ambiguous"; ids: number[] }
  | { tag: "alias_invalid"; reason: string };

// Sheet's CWP Total column = "0" (or absent) AND no implant rows ⇒ organic by
// the spreadsheet itself. We auto-mark these so the operator doesn't have to
// hand-curate every chrome-free character into the alias file.
function isOrganicFromSheet(block: CharBlock): boolean {
  if (block.implants.length > 0) return false;
  const t = (block.cwpTotal ?? "").trim();
  return t === "" || t === "0";
}

async function resolveAliasTargetId(
  kind: "pc" | "npc",
  block: CharBlock,
  alias: AliasEntry,
): Promise<{ id: number } | { error: string } | { ambiguous: number[] } | { missing: true }> {
  if (alias.action === "match" || alias.characterId) {
    const id = alias.characterId!;
    const check = await validateAliasTarget(kind, id);
    if (check === "missing") return { error: `alias points at #${id} but no such character row exists` };
    if (check === "wrong_kind") return { error: `alias points at #${id} but it's not a ${kind}` };
    return { id };
  }
  // Organic alias without explicit id — fall back to name lookup.
  const hit = await findByName(kind, block.name);
  if (hit.kind === "missing") return { missing: true };
  if (hit.kind === "ambiguous") return { ambiguous: hit.ids };
  return { id: hit.id };
}

async function resolveBlock(
  kind: "pc" | "npc",
  block: CharBlock,
  alias: AliasEntry | undefined,
): Promise<Outcome> {
  // 1. Alias takes precedence. Always validate the target before mutating.
  if (alias) {
    const target = await resolveAliasTargetId(kind, block, alias);
    if ("error" in target) return { tag: "alias_invalid", reason: target.reason ?? target.error };
    if ("ambiguous" in target) return { tag: "ambiguous", ids: target.ambiguous };
    if ("missing" in target) return { tag: "missing" };
    if (alias.action === "organic") {
      const r = await markOrganic(target.id);
      return { tag: r.conflict ? "organic_conflict" : "organic", id: target.id, deleted: r.deleted };
    }
    const r = await applyBlock(target.id, block);
    return { tag: "chrome", id: target.id, inserted: r.inserted, deleted: r.deleted };
  }

  // 2. No alias: case-insensitive exact name lookup.
  const hit = await findByName(kind, block.name);
  if (hit.kind === "missing") return { tag: "missing" };
  if (hit.kind === "ambiguous") return { tag: "ambiguous", ids: hit.ids };

  // 3. Sheet itself says organic? Stamp it.
  if (isOrganicFromSheet(block)) {
    const r = await markOrganic(hit.id);
    return { tag: r.conflict ? "organic_conflict" : "organic", id: hit.id, deleted: r.deleted };
  }

  // 4. Has implants ⇒ insert chrome.
  if (block.implants.length > 0) {
    const r = await applyBlock(hit.id, block);
    return { tag: "chrome", id: hit.id, inserted: r.inserted, deleted: r.deleted };
  }

  // 5. CWP > 0 but no implant rows parsed — unusual sheet state; surface it.
  return { tag: "alias_invalid", reason: `sheet has CWP ${block.cwpTotal} but no implant rows — needs manual review` };
}

async function main() {
  console.log(`Reading ${FILE}`);
  const aliases = loadAliases();
  const pcBlocks = parseBlocks("Character CWP Tracking");
  const npcBlocks = parseBlocks("NPC CWP Tracking");
  console.log(`Aliases loaded: ${Object.keys(aliases.pc).length} PC, ${Object.keys(aliases.npc).length} NPC`);
  console.log(`Parsed PCs: ${pcBlocks.length} blocks (${pcBlocks.reduce((a, b) => a + b.implants.length, 0)} implants)`);
  console.log(`Parsed NPCs: ${npcBlocks.length} blocks (${npcBlocks.reduce((a, b) => a + b.implants.length, 0)} implants)`);

  type Stats = {
    chrome: number; organic: number; inserted: number; deleted: number;
    missing: string[]; ambiguous: string[]; conflicts: string[]; invalid: string[];
  };
  const mk = (): Stats => ({ chrome: 0, organic: 0, inserted: 0, deleted: 0, missing: [], ambiguous: [], conflicts: [], invalid: [] });

  async function run(kind: "pc" | "npc", blocks: CharBlock[], aliasMap: Record<string, AliasEntry>): Promise<Stats> {
    const s = mk();
    for (const block of blocks) {
      const alias = aliasMap[block.name];
      const tag = `${block.name}${block.playerName ? ` (${block.playerName})` : ""}`;
      let out: Outcome;
      try {
        out = await resolveBlock(kind, block, alias);
      } catch (err) {
        // Per-block isolation: one bad alias shouldn't abort the whole import.
        s.invalid.push(`${tag} — ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      switch (out.tag) {
        case "chrome":
          s.chrome++; s.inserted += out.inserted; s.deleted += out.deleted;
          if (process.env.VERBOSE) console.log(`  ${kind.toUpperCase()} ${tag} → #${out.id}: -${out.deleted} +${out.inserted}`);
          break;
        case "organic":
          s.organic++; s.deleted += out.deleted;
          console.log(`  ${kind.toUpperCase()} ${tag} → #${out.id}: marked ORGANIC (cleared ${out.deleted} prior chrome rows)`);
          break;
        case "organic_conflict":
          s.conflicts.push(`${tag} → #${out.id} has non-importer chrome rows; refused to mark organic`);
          break;
        case "missing":
          // Silently drop alias-less, implant-less rows — they're the
          // "no chrome listed, no known target" tail and the user has said
          // we'll triage them later, not auto-create characters.
          if (alias || block.implants.length > 0) s.missing.push(tag);
          break;
        case "ambiguous":
          s.ambiguous.push(`${tag} → ids [${out.ids.join(", ")}]`);
          break;
        case "alias_invalid":
          s.invalid.push(`${tag} — ${out.reason}`);
          break;
      }
    }
    return s;
  }

  const pc = await run("pc", pcBlocks, aliases.pc);
  const npc = await run("npc", npcBlocks, aliases.npc);

  console.log("\n=== Summary ===");
  for (const [label, s] of [["PCs", pc], ["NPCs", npc]] as const) {
    console.log(`${label}: ${s.chrome} chromed (-${s.deleted} +${s.inserted}), ${s.organic} organic, ${s.missing.length} unmatched, ${s.ambiguous.length} ambiguous, ${s.conflicts.length} organic-conflicts, ${s.invalid.length} invalid`);
    if (s.missing.length) {
      console.log(`  Unmatched ${label} (need alias map entry):`);
      for (const m of s.missing) console.log(`    - ${m}`);
    }
    if (s.ambiguous.length) {
      console.log(`  Ambiguous ${label} (duplicate names — add alias map entry):`);
      for (const a of s.ambiguous) console.log(`    - ${a}`);
    }
    if (s.conflicts.length) {
      console.log(`  Organic conflicts ${label} (chrome still present, not flagged organic):`);
      for (const c of s.conflicts) console.log(`    - ${c}`);
    }
    if (s.invalid.length) {
      console.log(`  Invalid aliases / sheet rows ${label}:`);
      for (const i of s.invalid) console.log(`    - ${i}`);
    }
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
