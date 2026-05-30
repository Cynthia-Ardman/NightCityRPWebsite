import pg from "pg";

/**
 * Cyberware de-duplication for the LIVE prod DB.
 *
 * Some characters were imported twice (a legacy copy + a v1 copy), so the same
 * physical chrome is counted twice toward CWP. Rule of the setting: no non-NPC
 * character may exceed 15 CWP. Any non-NPC over 15 has duplicate inventory_items
 * rows that must be collapsed.
 *
 * Connects ONLY to LIVE_PROD_DATABASE_URL (the Neon DB nightcityroleplay.com
 * uses). Refuses to run against the legacy uuid DB.
 *
 * Modes:
 *   (default)        → REPORT ONLY. Prints over-15 characters, their cyberware
 *                      items, the duplicate groups detected, and exactly which
 *                      rows it WOULD delete. Writes nothing.
 *   APPLY=1          → actually deletes the flagged duplicate rows, inside a
 *                      single transaction, and re-verifies every affected
 *                      character lands at <= 15 CWP before COMMIT.
 *
 * Run:
 *   pnpm --filter @workspace/scripts exec tsx src/dedupe-cyberware.ts          # report
 *   APPLY=1 pnpm --filter @workspace/scripts exec tsx src/dedupe-cyberware.ts  # apply
 */

const { Pool } = pg;

const CWP_PATTERNS = [
  /\bcwp\b[\s:=-]*?(\d+(?:\.\d+)?)/i,
  /\bc\.w\.p\.?\b[\s:=-]*?(\d+(?:\.\d+)?)/i,
  /(\d+(?:\.\d+)?)\s*(?:cwp|c\.w\.p\.?|points?|pts?\.?)\b/i,
];
function parseCwp(notes: string | null): number | null {
  if (!notes) return null;
  for (const re of CWP_PATTERNS) {
    const m = notes.match(re);
    if (m) {
      const n = parseFloat(m[1]);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}
type Item = {
  id: number;
  name: string;
  notes: string | null;
  qty: number;
  cwp: number;
  created_at: Date;
};
function cwpForItem(it: { notes: string | null; qty: number }): number {
  const p = parseCwp(it.notes);
  return p != null ? p * Math.max(1, it.qty ?? 1) : 0;
}
function norm(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const CAP = 15;

async function main(): Promise<void> {
  const url = process.env.LIVE_PROD_DATABASE_URL;
  if (!url) throw new Error("LIVE_PROD_DATABASE_URL is not set");
  if (/postgres(ql)?:\/\//.test(url) === false) throw new Error("LIVE_PROD_DATABASE_URL malformed");

  const pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  const apply = process.env.APPLY === "1";

  // Sanity: confirm this is the portal schema (serial ints), not the legacy
  // uuid DB. inventory_items.id is integer in the portal, uuid in legacy.
  const colType = await pool.query(
    `SELECT data_type FROM information_schema.columns
     WHERE table_name='inventory_items' AND column_name='id'`,
  );
  const idType = colType.rows[0]?.data_type;
  if (idType !== "integer" && idType !== "bigint") {
    throw new Error(`Refusing: inventory_items.id is '${idType}', not the portal serial schema (looks like the legacy DB).`);
  }

  const { rows } = await pool.query(`
    SELECT i.id, i.character_id, i.name, i.notes, i.quantity, i.created_at,
           c.name AS char_name, c.kind AS char_kind, c.owner_id
    FROM inventory_items i
    JOIN characters c ON c.id = i.character_id
    WHERE i.category = 'cyberware'
    ORDER BY i.character_id, i.id`);

  type Char = { id: number; name: string; kind: string; owner_id: string | null; items: Item[] };
  const byChar = new Map<number, Char>();
  for (const r of rows) {
    if (!byChar.has(r.character_id)) {
      byChar.set(r.character_id, {
        id: r.character_id, name: r.char_name, kind: r.char_kind, owner_id: r.owner_id, items: [],
      });
    }
    const it: Item = {
      id: r.id, name: r.name, notes: r.notes, qty: r.quantity,
      cwp: cwpForItem({ notes: r.notes, qty: r.quantity }), created_at: r.created_at,
    };
    byChar.get(r.character_id)!.items.push(it);
  }

  const totalOf = (items: Item[]) => items.reduce((s, it) => s + it.cwp, 0);

  // Duplicate detection: within ONE character, group cyberware rows by
  // (normalized name + per-unit cwp). Any group with >1 row is a duplicate set.
  // We keep the NEWEST row (highest id — the v1 import) and flag the older
  // legacy copies for deletion. Only point-bearing rows (cwp>0) are ever
  // flagged; 0-CWP rows never affect the total and are left untouched.
  function dupesFor(items: Item[]): Item[] {
    const groups = new Map<string, Item[]>();
    for (const it of items) {
      if (it.cwp <= 0) continue;
      const perUnit = parseCwp(it.notes);
      const key = `${norm(it.name)}|${perUnit}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(it);
    }
    const toDelete: Item[] = [];
    for (const g of groups.values()) {
      if (g.length <= 1) continue;
      g.sort((a, b) => a.id - b.id); // oldest first
      toDelete.push(...g.slice(0, -1)); // keep newest (last), delete the rest
    }
    return toDelete;
  }

  const over = [...byChar.values()].filter((c) => c.kind !== "npc" && totalOf(c.items) > CAP);
  over.sort((a, b) => totalOf(b.items) - totalOf(a.items));

  console.log(`Mode: ${apply ? "APPLY (will delete)" : "REPORT ONLY (no writes)"}`);
  console.log(`Cyberware-bearing characters: ${byChar.size}`);
  console.log(`Non-NPC characters over ${CAP} CWP: ${over.length}\n`);

  const allDeleteIds: number[] = [];
  const stillOver: string[] = [];

  for (const c of over) {
    const before = totalOf(c.items);
    const del = dupesFor(c.items);
    const delIds = new Set(del.map((d) => d.id));
    const after = totalOf(c.items.filter((it) => !delIds.has(it.id)));
    allDeleteIds.push(...del.map((d) => d.id));
    if (after > CAP) stillOver.push(`#${c.id} ${c.name} → ${after} CWP after dedup`);

    console.log(`#${c.id} ${c.name} [${c.kind}] owner=${c.owner_id ?? "NONE"}`);
    console.log(`   total ${before} → ${after} CWP  (deleting ${del.length} dup row${del.length === 1 ? "" : "s"})`);
    for (const it of c.items) {
      const flag = delIds.has(it.id) ? "  ❌ DELETE" : "";
      console.log(`     [${it.id}] ${it.name} — ${it.cwp} CWP (qty ${it.qty})${flag}`);
    }
    console.log("");
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Rows flagged for deletion: ${allDeleteIds.length}`);
  console.log(`Delete ids: ${allDeleteIds.join(", ") || "(none)"}`);
  if (stillOver.length) {
    console.log(`\n⚠️  Characters STILL over ${CAP} after name+cwp dedup (need manual review):`);
    for (const s of stillOver) console.log(`   ${s}`);
  }

  if (!apply) {
    console.log(`\nREPORT ONLY — no rows deleted. Re-run with APPLY=1 to delete the flagged rows.`);
    await pool.end();
    return;
  }

  if (stillOver.length) {
    console.log(`\nABORT: some characters remain over ${CAP} after dedup. Refusing to apply a partial fix.`);
    await pool.end();
    process.exitCode = 1;
    return;
  }
  if (allDeleteIds.length === 0) {
    console.log(`\nNothing to delete.`);
    await pool.end();
    return;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const res = await client.query(
      `DELETE FROM inventory_items WHERE id = ANY($1::int[]) AND category = 'cyberware'`,
      [allDeleteIds],
    );
    console.log(`\nDeleted ${res.rowCount} rows.`);
    if (res.rowCount !== allDeleteIds.length) {
      throw new Error(`Expected to delete ${allDeleteIds.length} rows but deleted ${res.rowCount}; rolling back.`);
    }
    await client.query("COMMIT");
    console.log("COMMIT ok.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("ROLLBACK:", err);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
