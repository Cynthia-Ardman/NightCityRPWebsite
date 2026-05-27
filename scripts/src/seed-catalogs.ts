import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as XLSX from "xlsx";
import { db, pool, catalogRent } from "@workspace/db";

/**
 * Seeds the rent listings catalog from the attached spreadsheet.
 *
 * Note: catalog_guns and catalog_cyberware are the prod bot's source of truth
 * and are synced from prod via scripts/src/sync-from-prod.ts — they are not
 * touched here. The rent spreadsheet is the only source for catalog_rent.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..", "..");
const ASSETS = path.join(ROOT, "attached_assets");

const RENT_FILE = "NCRP_Rent_and_Leases(1)_1779909404701.xlsx";

type Row = (string | number | null)[];

function loadSheet(file: string, sheetName?: string): Row[] {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const wb = XLSX.read(buf, { type: "buffer" });
  const sn = sheetName ?? wb.SheetNames[0];
  const sheet = wb.Sheets[sn];
  if (!sheet) throw new Error(`Sheet "${sn}" not found in ${file}`);
  return XLSX.utils.sheet_to_json<Row>(sheet, { header: 1, defval: null });
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
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function buildRent() {
  const rows = loadSheet(RENT_FILE, "Beastside");
  const district = "Beastside";
  const out: (typeof catalogRent.$inferInsert)[] = [];
  let tier: string | null = null;
  let building: string | null = null;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r) continue;
    const tierCell = str(r[0]);
    const buildingCell = str(r[2]);
    const businessCell = str(r[3]);
    const room = str(r[5]);
    const rent = toInt(r[6]);
    if (tierCell) tier = tierCell;
    if (buildingCell) building = buildingCell;
    if (rent === null) continue;
    const name = businessCell ?? building ?? buildingCell;
    if (!name) continue;
    const businessOpCost = r[4];
    const opCostStr = typeof businessOpCost === "string" ? businessOpCost : null;
    const opCostNum = typeof businessOpCost === "number" ? businessOpCost : null;
    const descParts = [
      building && businessCell && building !== businessCell ? `Building: ${building}` : null,
      room ? `Room: ${room}` : null,
      opCostNum !== null ? `Operating cost: ${opCostNum.toLocaleString()} €$` : null,
      opCostStr,
    ].filter(Boolean);
    out.push({
      name,
      district,
      tier,
      monthlyRent: rent,
      description: descParts.length ? descParts.join(" • ") : null,
    });
  }
  return out;
}

async function main() {
  const rent = buildRent();
  console.log(`Parsed ${rent.length} rent listings.`);
  await db.transaction(async (tx) => {
    await tx.delete(catalogRent);
    if (rent.length) await tx.insert(catalogRent).values(rent);
  });
  console.log("Rent catalog seeded successfully.");
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
