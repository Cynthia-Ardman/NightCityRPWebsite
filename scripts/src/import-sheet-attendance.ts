/**
 * One-way importer: public Google Sheet mission-attendance tracker -> portal.
 *
 * Reads the community's manually-maintained attendance sheet (per-player rows:
 * Discord ID, username(s), appearance count, list of dates) and merges it into
 * the portal's existing per-player historical mission-attendance store
 * (`bot_mission_log`). One-way only: nothing is ever written back to the sheet.
 *
 * Merge semantics (idempotent):
 *   - Rows are keyed by Discord ID. A Discord ID that appears on multiple sheet
 *     rows (alt usernames / name changes) is merged into one entry.
 *   - mission_dates  = union(existing dates, sheet dates), de-duplicated.
 *   - mission_count  = number of distinct dates after the union.
 *   - username       = kept if already present, else the sheet username(s).
 *   - mission_titles = left untouched (the sheet carries no titles).
 *   Re-running the importer unions the same dates and is therefore a no-op.
 *
 * Target selection (mirrors the other import-*.ts scripts):
 *   - default            -> DATABASE_URL           (dev)
 *   - IMPORT_TARGET=live -> LIVE_PROD_DATABASE_URL (the Neon DB the site uses)
 *
 * Usage:
 *   pnpm --filter @workspace/scripts exec tsx src/import-sheet-attendance.ts
 *   IMPORT_TARGET=live pnpm --filter @workspace/scripts exec tsx src/import-sheet-attendance.ts
 */
import { Client } from "pg";

const SHEET_ID = "1Q0dspKFU_R8q5JAquFFoxuOs6Vd_MGkXCjXDiMRo-Fg";
const SHEET_URL =
  process.env.SHEET_URL ??
  `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv`;

const targetIsLive = process.env.IMPORT_TARGET === "live";
const TARGET = targetIsLive
  ? process.env.LIVE_PROD_DATABASE_URL
  : process.env.DATABASE_URL;

if (!TARGET) {
  console.error(
    targetIsLive
      ? "LIVE_PROD_DATABASE_URL is not set (IMPORT_TARGET=live)"
      : "DATABASE_URL is not set",
  );
  process.exit(1);
}

/**
 * Minimal RFC-4180 CSV parser that keeps EVERY field as a string. We must not
 * use a spreadsheet/number parser here: Discord IDs are 64-bit snowflakes that
 * exceed Number.MAX_SAFE_INTEGER, so numeric coercion silently corrupts the
 * join key (e.g. 262434049862270976 -> 262434049862270980).
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let sawField = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
      sawField = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
      sawField = true;
    } else if (c === "\r") {
      // ignore — handled by the \n branch
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      sawField = false;
    } else {
      field += c;
      sawField = true;
    }
  }
  if (sawField || field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Normalize "M/D/YYYY" or "M/D/YY" to an ISO "YYYY-MM-DD" date, else null. */
function toIsoDate(raw: string): string | null {
  const m = raw.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  let year = Number(m[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  // Reject impossible calendar dates (e.g. 2/31) by round-tripping through Date.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

type Entry = { usernames: Set<string>; dates: Set<string> };

async function fetchSheetRows(): Promise<string[][]> {
  const resp = await fetch(SHEET_URL, {
    redirect: "follow",
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    throw new Error(`Sheet fetch failed: HTTP ${resp.status} ${resp.statusText}`);
  }
  const text = await resp.text();
  return parseCsv(text);
}

async function main() {
  const rows = await fetchSheetRows();
  if (rows.length === 0) throw new Error("Sheet is empty");

  // Drop the header row (Discord ID, Username(s), Appearances, Dates).
  const dataRows = rows.slice(1);

  const byUser = new Map<string, Entry>();
  let skipped = 0;
  for (const r of dataRows) {
    const userId = r[0] == null ? "" : String(r[0]).trim();
    if (!/^\d{5,}$/.test(userId)) {
      skipped++;
      continue;
    }
    const username = r[1] == null ? "" : String(r[1]).replace(/\s+/g, " ").trim();
    const datesCell = r[3] == null ? "" : String(r[3]);

    let entry = byUser.get(userId);
    if (!entry) {
      entry = { usernames: new Set(), dates: new Set() };
      byUser.set(userId, entry);
    }
    if (username) entry.usernames.add(username);
    for (const part of datesCell.split(",")) {
      const iso = toIsoDate(part);
      if (iso) entry.dates.add(iso);
    }
  }

  const client = new Client({ connectionString: TARGET });
  await client.connect();

  let upserted = 0;
  let totalDates = 0;
  try {
    for (const [userId, entry] of byUser) {
      const dates = [...entry.dates].sort();
      totalDates += dates.length;
      const username =
        [...entry.usernames].join(" / ").slice(0, 256) || null;
      // Union with any existing dates on conflict so re-runs are idempotent and
      // never clobber legacy bot data; recompute the count from the union.
      await client.query(
        `INSERT INTO bot_mission_log
           (user_id, username, mission_count, mission_dates, mission_titles, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, '[]'::jsonb, now())
         ON CONFLICT (user_id) DO UPDATE SET
           username = COALESCE(bot_mission_log.username, EXCLUDED.username),
           mission_dates = (
             SELECT COALESCE(jsonb_agg(d ORDER BY d), '[]'::jsonb)
             FROM (
               SELECT DISTINCT jsonb_array_elements_text(
                 bot_mission_log.mission_dates || EXCLUDED.mission_dates
               ) AS d
             ) u
           ),
           mission_count = (
             SELECT count(*)
             FROM (
               SELECT DISTINCT jsonb_array_elements_text(
                 bot_mission_log.mission_dates || EXCLUDED.mission_dates
               ) AS d
             ) u
           ),
           updated_at = now()`,
        [userId, username, dates.length, JSON.stringify(dates)],
      );
      upserted++;
    }
  } finally {
    await client.end();
  }

  console.log(
    `[import-sheet-attendance] target=${targetIsLive ? "LIVE" : "dev"} ` +
      `rows=${dataRows.length} skipped=${skipped} ` +
      `players=${byUser.size} upserted=${upserted} sheetDates=${totalDates}`,
  );
}

main().catch((e) => {
  console.error("[import-sheet-attendance] failed:", e);
  process.exit(1);
});
