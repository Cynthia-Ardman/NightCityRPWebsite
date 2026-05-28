import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db, pool, characters } from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");

const FILE = "NCRP__Cyberware_list_v2(4)_1779935087641.xlsx";
const SHEET = "NPC CWP Tracking";

type Row = (string | number | null)[];

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

type Implant = {
  name: string;
  cwp: string | null;
  brand: string | null;
  brandTier: string | null;
  fn: string | null;
  slot: string | null;
  notes: string | null;
};

type Npc = {
  name: string;
  playerName: string | null;
  cwpTotal: string | null;
  implants: Implant[];
};

function parseNpcs(): Npc[] {
  const rows = loadSheet(FILE, SHEET);
  // Header is row 0: Character | Player Name | CWP Total | Implant Name | CWP | Brand | Brand Tier | Function | Slot/Type | Notes
  const npcs: Npc[] = [];
  let cur: Npc | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const character = str(r[0]);
    const player = str(r[1]);
    const cwpTotal = str(r[2]);
    const implantName = str(r[3]);
    if (character) {
      // New NPC block.
      cur = { name: character, playerName: player, cwpTotal, implants: [] };
      npcs.push(cur);
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
  return npcs;
}

function renderCyberwareBlock(npc: Npc): string {
  if (!npc.implants.length) return "";
  const lines: string[] = [];
  lines.push("# Cyberware");
  if (npc.cwpTotal) lines.push(`Total CWP: ${npc.cwpTotal}`);
  lines.push("");
  for (const im of npc.implants) {
    const head = im.cwp ? `- ${im.name} (CWP ${im.cwp})` : `- ${im.name}`;
    lines.push(head);
    const detail: string[] = [];
    if (im.slot) detail.push(`slot: ${im.slot}`);
    if (im.fn) detail.push(`fn: ${im.fn}`);
    if (im.brand) detail.push(`brand: ${im.brand}${im.brandTier ? ` (${im.brandTier})` : ""}`);
    if (im.notes) detail.push(`notes: ${im.notes}`);
    if (detail.length) lines.push(`  ${detail.join(" · ")}`);
  }
  return lines.join("\n");
}

async function main() {
  const npcs = parseNpcs();
  console.log(`Parsed ${npcs.length} NPCs (with ${npcs.reduce((a, n) => a + n.implants.length, 0)} implant rows).`);

  let inserted = 0;
  let updated = 0;
  for (const npc of npcs) {
    const block = renderCyberwareBlock(npc);
    // Idempotent upsert keyed on (kind='npc', name). Preserve admin-assigned
    // ownerId via coalesce. We embed the cyberware block in background under
    // a sentinel marker so reruns replace just that section without clobbering
    // any other manual background text or `[legacy:<uuid>]` anchors.
    const sentinelStart = "<!--cyberware-import-start-->";
    const sentinelEnd = "<!--cyberware-import-end-->";
    const wrapped = block ? `${sentinelStart}\n${block}\n${sentinelEnd}` : "";

    const existing = await db.execute<{ id: number; background: string | null }>(sql`
      SELECT id, background FROM characters WHERE kind = 'npc' AND name = ${npc.name} LIMIT 1
    `);
    if (existing.rows.length === 0) {
      const newBg = wrapped || null;
      const [row] = await db.insert(characters).values({
        name: npc.name,
        kind: "npc",
        claimed: false,
        ownerId: null,
        legacyDiscordUsername: npc.playerName,
        background: newBg,
        archetype: null,
        lifeStatus: "active",
        approved: true,
      }).returning({ id: characters.id });
      inserted++;
      if (process.env.VERBOSE) console.log(`  + NPC ${npc.name} (#${row.id}) ${npc.implants.length} implants`);
    } else {
      const cur = existing.rows[0];
      const prev = cur.background ?? "";
      const re = new RegExp(`${sentinelStart}[\\s\\S]*?${sentinelEnd}`, "m");
      const next = re.test(prev)
        ? prev.replace(re, wrapped)
        : (prev ? `${prev.trimEnd()}\n\n${wrapped}` : wrapped);
      await db.execute(sql`
        UPDATE characters
        SET background = ${next || null},
            legacy_discord_username = COALESCE(legacy_discord_username, ${npc.playerName})
        WHERE id = ${cur.id}
      `);
      updated++;
      if (process.env.VERBOSE) console.log(`  ~ NPC ${npc.name} (#${cur.id}) refreshed (${npc.implants.length} implants)`);
    }
  }

  console.log(`\nDone. Inserted ${inserted}, updated ${updated}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
