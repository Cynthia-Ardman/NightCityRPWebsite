/**
 * Sync the Lore Directory schema into the LIVE production database.
 *
 * This project's live site runs on Neon (LIVE_PROD_DATABASE_URL), NOT the
 * Replit-managed DB, so the publish-time schema diff does NOT apply here — the
 * lore tables have to be created explicitly. This script is intentionally
 * ADDITIVE and IDEMPOTENT: every statement is CREATE TABLE / CREATE INDEX
 * IF NOT EXISTS and it only ever touches the three lore_* tables, so it can
 * never alter or drop anything else even if dev and prod have drifted. Safe to
 * re-run.
 *
 *   LIVE_PROD_DATABASE_URL must be set (we refuse to fall back to DATABASE_URL).
 *
 *   pnpm --filter @workspace/scripts exec tsx src/sync-lore-schema-to-prod.ts [--dry-run]
 */
import pg from "pg";

const { Pool } = pg;
const DRY = process.argv.includes("--dry-run");

const DB_URL = process.env.LIVE_PROD_DATABASE_URL;
if (!DB_URL) {
  console.error("LIVE_PROD_DATABASE_URL must be set — refusing to run against an unknown database.");
  process.exit(1);
}

// The three tables this script is allowed to create, with their expected
// columns. Used purely for before/after verification — never for dropping.
const EXPECTED: Record<string, string[]> = {
  lore_entries: [
    "id", "category", "name", "slug", "aliases", "responsible_fixer", "summary",
    "public_body", "fixer_body", "sources", "created_by_id", "updated_by_id",
    "created_at", "updated_at",
  ],
  lore_pending_edits: [
    "id", "lore_entry_id", "kind", "submitted_by", "proposed_diff",
    "before_snapshot", "update_note", "status", "decided_by_id", "decided_at",
    "decision_summary", "applied_entry_id", "created_at",
  ],
  lore_import_drafts: [
    "id", "group_key", "proposed_name", "proposed_category", "proposed_fixer",
    "aliases", "summary", "public_body", "fixer_body", "sources",
    "suggested_merge_entry_id", "status", "source_key", "decided_by_id",
    "decided_at", "applied_entry_id", "created_at",
  ],
};

// Additive, idempotent DDL. lore_entries is created first because the other two
// reference it.
const DDL = `
CREATE TABLE IF NOT EXISTS lore_entries (
  id serial PRIMARY KEY,
  category text NOT NULL DEFAULT 'misc',
  name text NOT NULL,
  slug text NOT NULL,
  aliases text[] NOT NULL DEFAULT '{}',
  responsible_fixer text,
  summary text,
  public_body text NOT NULL DEFAULT '',
  fixer_body text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by_id text REFERENCES users(id),
  updated_by_id text REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS lore_entries_slug_idx ON lore_entries (slug);
CREATE INDEX IF NOT EXISTS lore_entries_category_idx ON lore_entries (category);
CREATE INDEX IF NOT EXISTS lore_entries_name_idx ON lore_entries (name);

CREATE TABLE IF NOT EXISTS lore_pending_edits (
  id serial PRIMARY KEY,
  lore_entry_id integer REFERENCES lore_entries(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'edit',
  submitted_by text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  proposed_diff jsonb NOT NULL,
  before_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  update_note text,
  status text NOT NULL DEFAULT 'pending',
  decided_by_id text REFERENCES users(id),
  decided_at timestamptz,
  decision_summary text,
  applied_entry_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lore_pending_edits_status_idx ON lore_pending_edits (status);
CREATE INDEX IF NOT EXISTS lore_pending_edits_entry_idx ON lore_pending_edits (lore_entry_id);

CREATE TABLE IF NOT EXISTS lore_import_drafts (
  id serial PRIMARY KEY,
  group_key text NOT NULL,
  proposed_name text NOT NULL,
  proposed_category text NOT NULL DEFAULT 'misc',
  proposed_fixer text,
  aliases text[] NOT NULL DEFAULT '{}',
  summary text,
  public_body text NOT NULL DEFAULT '',
  fixer_body text,
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggested_merge_entry_id integer REFERENCES lore_entries(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending',
  source_key text,
  decided_by_id text REFERENCES users(id),
  decided_at timestamptz,
  applied_entry_id integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lore_import_drafts_status_idx ON lore_import_drafts (status);
CREATE INDEX IF NOT EXISTS lore_import_drafts_group_key_idx ON lore_import_drafts (group_key);
CREATE INDEX IF NOT EXISTS lore_import_drafts_source_key_idx ON lore_import_drafts (source_key);
CREATE UNIQUE INDEX IF NOT EXISTS lore_import_drafts_pending_group_uq
  ON lore_import_drafts (group_key) WHERE status = 'pending';
`;

async function snapshot(pool: pg.Pool): Promise<Record<string, string[]>> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [Object.keys(EXPECTED)],
  );
  const out: Record<string, string[]> = {};
  for (const r of rows) (out[r.table_name] ??= []).push(r.column_name);
  return out;
}

function report(label: string, snap: Record<string, string[]>): void {
  console.log(`\n${label}:`);
  for (const table of Object.keys(EXPECTED)) {
    const cols = snap[table];
    if (!cols) {
      console.log(`  ${table}: (does not exist)`);
      continue;
    }
    const missing = EXPECTED[table].filter((c) => !cols.includes(c));
    console.log(`  ${table}: ${cols.length} columns${missing.length ? ` — MISSING: ${missing.join(", ")}` : " ✓"}`);
  }
}

async function main(): Promise<void> {
  // Mask everything but the host so the log proves we hit the intended DB
  // without leaking credentials.
  let host = "unknown";
  try { host = new URL(DB_URL!).host; } catch { /* ignore */ }
  console.log(`Target: ${host} ${DRY ? "(DRY RUN — no changes)" : "(APPLYING)"}`);

  const pool = new Pool({ connectionString: DB_URL! });

  const before = await snapshot(pool);
  report("BEFORE", before);

  if (DRY) {
    console.log("\nDry run — skipping DDL.");
    await pool.end();
    return;
  }

  await pool.query("BEGIN");
  try {
    await pool.query(DDL);
    await pool.query("COMMIT");
  } catch (e) {
    await pool.query("ROLLBACK").catch(() => {});
    throw e;
  }

  const after = await snapshot(pool);
  report("AFTER", after);

  const stillMissing = Object.keys(EXPECTED).flatMap((t) =>
    (after[t] ?? []).length === 0
      ? [`${t} (table absent)`]
      : EXPECTED[t].filter((c) => !(after[t] ?? []).includes(c)).map((c) => `${t}.${c}`),
  );
  if (stillMissing.length) {
    console.error(`\n✗ Schema still incomplete after apply: ${stillMissing.join(", ")}`);
    await pool.end();
    process.exit(1);
  }

  console.log("\n✓ Lore schema is fully present in production.");
  await pool.end();
}

main().catch((e) => {
  console.error("Migration failed:", e);
  process.exit(1);
});
