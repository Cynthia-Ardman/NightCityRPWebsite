// Coverage report for the cyberware roster spreadsheet vs the DB.
// Three sections:
//   1. Spreadsheet entries (PC + NPC) that did NOT match any character row.
//   2. Player characters (kind='pc', not archived) with zero cyberware items.
//   3. NPCs (kind='npc') with zero cyberware items.
// For unmatched spreadsheet entries we also print the closest DB name(s) by
// case-insensitive substring match on either side, plus any character whose
// legacy_discord_username matches the sheet's Player Name — so the user can
// pick the right target and feed it back as an alias.
//
// Read-only. Safe to run any time.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db, pool } from "@workspace/db";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");

const FILE = process.env.CYBERWARE_FILE ?? "NCRP__Cyberware_list_v2(1)_1779978749744.xlsx";

type Row = (string | number | null)[];
type Block = { name: string; player: string | null; cwpTotal: string | null; implantCount: number };

function loadSheet(sheetName: string): Row[] {
  const buf = fs.readFileSync(path.join(ASSETS, FILE));
  const wb = XLSX.read(buf, { type: "buffer" });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`Sheet "${sheetName}" not found`);
  return XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, defval: null });
}

function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function parseBlocks(sheetName: string): Block[] {
  const rows = loadSheet(sheetName);
  const out: Block[] = [];
  let cur: Block | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const character = str(r[0]);
    const implant = str(r[3]);
    if (character) {
      cur = { name: character, player: str(r[1]), cwpTotal: str(r[2]), implantCount: 0 };
      out.push(cur);
    }
    if (cur && implant) cur.implantCount++;
  }
  return out.filter((b) => b.implantCount > 0);
}

async function main() {
  const pcBlocks = parseBlocks("Character CWP Tracking");
  const npcBlocks = parseBlocks("NPC CWP Tracking");

  // All characters with their chrome counts.
  const chars = await db.execute<{
    id: number; name: string; kind: string; archived: boolean;
    legacy_discord_username: string | null; owner_id: string | null;
    chrome: number;
  }>(sql`
    SELECT c.id, c.name, c.kind, c.archived, c.legacy_discord_username, c.owner_id,
           COALESCE(i.chrome, 0)::int AS chrome
    FROM characters c
    LEFT JOIN (
      SELECT character_id, count(*) AS chrome FROM inventory_items
      WHERE category = 'cyberware' GROUP BY character_id
    ) i ON i.character_id = c.id
    ORDER BY c.kind, c.name
  `);
  const all = chars.rows;
  const byKind = (k: string) => all.filter((c) => c.kind === k);

  // Indexes for matching.
  const byLowerName = new Map<string, typeof all>();
  const byLegacy = new Map<string, typeof all>();
  for (const c of all) {
    const k = c.name.toLowerCase();
    const arr = byLowerName.get(k) ?? [];
    arr.push(c);
    byLowerName.set(k, arr);
    if (c.legacy_discord_username) {
      const lk = c.legacy_discord_username.toLowerCase();
      const arr2 = byLegacy.get(lk) ?? [];
      arr2.push(c);
      byLegacy.set(lk, arr2);
    }
  }

  // Substring suggestions on character name.
  function suggestByName(sheetName: string, kind: string): typeof all {
    const needle = sheetName.toLowerCase();
    const tokens = needle.split(/[^a-z0-9]+/).filter((t) => t.length >= 4);
    const hits = new Set<number>();
    const out: typeof all = [];
    for (const c of all) {
      if (c.kind !== kind) continue;
      const hay = c.name.toLowerCase();
      const hit = hay.includes(needle) || needle.includes(hay) || tokens.some((t) => hay.includes(t));
      if (hit && !hits.has(c.id)) {
        hits.add(c.id);
        out.push(c);
      }
    }
    return out.slice(0, 5);
  }

  function suggestByLegacy(player: string | null): typeof all {
    if (!player) return [];
    return (byLegacy.get(player.toLowerCase()) ?? []).slice(0, 5);
  }

  // ---- 1. Unmatched sheet entries ----
  console.log("================================================================");
  console.log("1. SPREADSHEET ENTRIES WITH NO MATCHING CHARACTER ROW");
  console.log("================================================================");

  function reportUnmatched(label: string, blocks: Block[], kind: string) {
    const unmatched = blocks.filter((b) => !byLowerName.has(b.name.toLowerCase()) || !byLowerName.get(b.name.toLowerCase())!.some((c) => c.kind === kind));
    const ambiguous = blocks.filter((b) => {
      const cs = (byLowerName.get(b.name.toLowerCase()) ?? []).filter((c) => c.kind === kind);
      return cs.length > 1;
    });
    console.log(`\n--- ${label}: ${unmatched.length} unmatched, ${ambiguous.length} ambiguous (same-name duplicates) ---`);
    for (const b of unmatched) {
      const byLegacyHit = suggestByLegacy(b.player).filter((c) => c.kind === kind);
      const byNameHit = suggestByName(b.name, kind);
      const merged = new Map<number, (typeof all)[number]>();
      for (const c of [...byLegacyHit, ...byNameHit]) merged.set(c.id, c);
      console.log(`\n  • "${b.name}"${b.player ? ` — player: ${b.player}` : ""}  [${b.implantCount} implants${b.cwpTotal ? ", CWP " + b.cwpTotal : ""}]`);
      if (merged.size === 0) {
        console.log(`      (no plausible match in DB)`);
      } else {
        for (const c of merged.values()) {
          const tags: string[] = [];
          if (c.archived) tags.push("ARCHIVED");
          if (c.legacy_discord_username) tags.push(`legacy=${c.legacy_discord_username}`);
          if (c.chrome > 0) tags.push(`already ${c.chrome} chrome`);
          console.log(`      → #${c.id} "${c.name}" (${c.kind})  ${tags.join(" · ")}`);
        }
      }
    }
    if (ambiguous.length) {
      console.log(`\n  Ambiguous (skipped by importer — multiple DB rows share the name):`);
      for (const b of ambiguous) {
        const cs = (byLowerName.get(b.name.toLowerCase()) ?? []).filter((c) => c.kind === kind);
        console.log(`    • "${b.name}"${b.player ? ` (player ${b.player})` : ""} → ids [${cs.map((c) => `#${c.id}${c.archived ? "(arch)" : ""}${c.legacy_discord_username ? " legacy=" + c.legacy_discord_username : ""}`).join(", ")}]`);
      }
    }
  }

  reportUnmatched("PCs", pcBlocks, "pc");
  reportUnmatched("NPCs", npcBlocks, "npc");

  // ---- 2 & 3. Characters with no chrome ----
  console.log("\n================================================================");
  console.log("2. PLAYER CHARACTERS WITH ZERO CYBERWARE");
  console.log("================================================================");
  const pcNoChrome = byKind("pc").filter((c) => c.chrome === 0 && !c.archived);
  console.log(`\n${pcNoChrome.length} active PCs have no cyberware rows:`);
  for (const c of pcNoChrome) {
    const legacy = c.legacy_discord_username ? ` legacy=${c.legacy_discord_username}` : "";
    const claimed = c.owner_id ? " CLAIMED" : " UNCLAIMED";
    console.log(`  #${c.id.toString().padStart(4)} ${c.name}${legacy}${claimed}`);
  }

  console.log("\n================================================================");
  console.log("3. NPCs WITH ZERO CYBERWARE");
  console.log("================================================================");
  const npcNoChrome = byKind("npc").filter((c) => c.chrome === 0);
  console.log(`\n${npcNoChrome.length} NPCs have no cyberware rows:`);
  for (const c of npcNoChrome) {
    const legacy = c.legacy_discord_username ? ` legacy=${c.legacy_discord_username}` : "";
    console.log(`  #${c.id.toString().padStart(4)} ${c.name}${legacy}`);
  }

  console.log("\n=== Totals ===");
  console.log(`Sheet PC blocks:  ${pcBlocks.length}     Sheet NPC blocks: ${npcBlocks.length}`);
  console.log(`DB PCs (active):  ${byKind("pc").filter((c) => !c.archived).length}     DB NPCs: ${byKind("npc").length}`);
  console.log(`PCs without chrome (active): ${pcNoChrome.length}`);
  console.log(`NPCs without chrome:         ${npcNoChrome.length}`);

  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch {}
  process.exit(1);
});
