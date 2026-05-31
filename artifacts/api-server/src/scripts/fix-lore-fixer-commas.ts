// One-off: comma-separate multi-lead responsible-fixer values on already-
// published lore entries. The live `responsible_fixer` is already flattened to
// bare names (mention ids gone), so two Story Leads read as "archie Shyzuki"
// instead of "archie, Shyzuki". We re-derive the field from the Story Leads
// thread (which still carries the raw <@id> mentions), comma-join adjacent
// leads, and update ONLY rows whose current value matches the comma-less
// version — so any manually edited fixer is left untouched.
//
// Usage (from repo root):
//   LORE_IMPORT_TARGET=dev  pnpm --filter @workspace/scripts exec tsx /home/runner/workspace/artifacts/api-server/src/scripts/fix-lore-fixer-commas.ts
//   LORE_IMPORT_TARGET=prod pnpm --filter @workspace/scripts exec tsx /home/runner/workspace/artifacts/api-server/src/scripts/fix-lore-fixer-commas.ts

export {};

const target = (process.env.LORE_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("LORE_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target !== "dev") {
  console.error("Set LORE_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

// Compare two fixer strings ignoring separators/case — "archie Shyzuki" and
// "archie, Shyzuki" collapse to the same key.
const sepless = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

async function main() {
  const { pool } = await import("@workspace/db");
  const { fetchStoryLeads, normalizeName, resolveFixerMentions } = await import("../lib/loreImport");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})`);

  const leads = await fetchStoryLeads();
  console.log(`Story Leads entries parsed: ${leads.size}`);

  const { rows } = await pool.query<{ id: number; name: string; responsible_fixer: string | null }>(
    "SELECT id, name, responsible_fixer FROM lore_entries",
  );

  const cache = new Map<string, string | null>();
  let updated = 0;
  let skippedManual = 0;
  for (const r of rows) {
    if (!r.responsible_fixer) continue;
    const raw = leads.get(normalizeName(r.name));
    if (!raw || !raw.includes("<@")) continue;
    const resolved = await resolveFixerMentions(raw, cache);
    // Only multi-lead fixers need the comma fix.
    if (!resolved.includes(", ")) continue;
    if (resolved === r.responsible_fixer) continue;
    // Safety: only rewrite when the current value is the comma-less form of the
    // re-derived names. Anything else is a manual edit — leave it.
    if (sepless(resolved) !== sepless(r.responsible_fixer)) {
      skippedManual++;
      continue;
    }
    await pool.query(
      "UPDATE lore_entries SET responsible_fixer=$1, updated_at=now() WHERE id=$2",
      [resolved, r.id],
    );
    console.log(`  #${r.id} ${r.name}: "${r.responsible_fixer}" -> "${resolved}"`);
    updated++;
  }

  console.log(`\nRows updated: ${updated}`);
  if (skippedManual) console.log(`Skipped (manual edits, names differ): ${skippedManual}`);
  await pool.end();
}

main().catch((err) => {
  console.error("fix-lore-fixer-commas failed:", err);
  process.exit(1);
});
