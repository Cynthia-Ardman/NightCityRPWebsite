/**
 * Additive import of bot-era financial history from the NCRP full-history
 * JSON export the user attached. Source: a JSON file (default: the attached
 * export). Target: DATABASE_URL (portal dev DB).
 *
 * Populates the bot_balance_history mirror table (THE bot transaction ledger:
 * every cash/bank delta with a free-text reason — rent, cyberware, attendance,
 * actor pay, mission payouts, purchases, etc.). This is what powers the
 * player-facing "FINANCIAL HISTORY" dialog.
 *
 * PURELY ADDITIVE: insert uses ON CONFLICT (bot_id) DO NOTHING, so existing
 * rows are never overwritten. Idempotent: safe to rerun. Linkage is per-player
 * via user_id (Discord ID).
 *
 *   pnpm --filter @workspace/scripts exec tsx src/import-bot-financials.ts [path-to-export.json]
 */
import fs from "node:fs";
import pg from "pg";

const DEFAULT_EXPORT =
  "attached_assets/ncrp_full_history_export_2026-06-02_1780388410104.json";

function assertDevTarget() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL (target) is required.");
  const targetHost = new URL(url).host;
  for (const [name, v] of Object.entries({
    OLD_BOT_DATABASE_URL: process.env.OLD_BOT_DATABASE_URL,
    PROD_DATABASE_URL: process.env.PROD_DATABASE_URL,
    LIVE_PROD_DATABASE_URL: process.env.LIVE_PROD_DATABASE_URL,
  })) {
    if (v && new URL(v).host === targetHost) {
      throw new Error(
        `Refusing to write: DATABASE_URL host matches ${name}. Target must be the portal dev DB.`,
      );
    }
  }
  return targetHost;
}

async function main() {
  const targetHost = assertDevTarget();
  const exportPath = process.argv[2] ?? DEFAULT_EXPORT;
  if (!fs.existsSync(exportPath)) throw new Error(`Export file not found: ${exportPath}`);
  const json = JSON.parse(fs.readFileSync(exportPath, "utf8"));
  const rows: any[] = json?.database?.balance_history ?? [];
  console.log(`Source: ${exportPath} (${rows.length} balance_history rows)  ->  Target (dev): ${targetHost}`);

  const target = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await target.connect();

  let inserted = 0;
  const CHUNK = 500;
  const valid = rows.filter((r) => r.user_id && r.ts && Number.isFinite(Number(r.id)));
  for (let i = 0; i < valid.length; i += CHUNK) {
    const chunk = valid.slice(i, i + CHUNK);
    const params: unknown[] = [];
    const tuples = chunk.map((r, ri) => {
      const b = ri * 6;
      params.push(
        Number(r.id),
        String(r.user_id),
        r.ts,
        Number(r.cash_delta ?? 0) || 0,
        Number(r.bank_delta ?? 0) || 0,
        r.reason ?? null,
      );
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`;
    });
    const res = await target.query(
      `INSERT INTO bot_balance_history (bot_id, user_id, ts, cash_delta, bank_delta, reason)
       VALUES ${tuples.join(",")}
       ON CONFLICT (bot_id) DO NOTHING`,
      params,
    );
    inserted += res.rowCount ?? 0;
  }

  const total = await target.query(`SELECT count(*)::int n FROM bot_balance_history`);
  console.table({ bot_balance_history: { received: valid.length, inserted, totalNow: total.rows[0].n } });
  await target.end();
  console.log("Done (additive, no overwrites).");
}

main().catch((err) => {
  console.error("import-bot-financials failed:", err);
  process.exit(1);
});
