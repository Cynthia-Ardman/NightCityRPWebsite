// One-off operational script: run the Guidebook importer, which pulls the fixed
// set of configured Discord source channels (GUIDEBOOK_SOURCES) and upserts them
// into live guidebookPages. Reads Discord via the bot (non-destructive); writes
// only to the target database.
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/import-guidebook.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/import-guidebook.ts
//
// Targeting prod requires LIVE_PROD_DATABASE_URL and is refused otherwise.

export {};

const target = (process.env.GUIDEBOOK_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("GUIDEBOOK_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  // Point the shared db pool at the live prod DB BEFORE importing @workspace/db.
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target === "dev") {
  // Guard against a mispointed DATABASE_URL silently writing to prod.
  const url = process.env.DATABASE_URL ?? "";
  const looksProd =
    !!process.env.LIVE_PROD_DATABASE_URL && url === process.env.LIVE_PROD_DATABASE_URL;
  if (looksProd) {
    console.error("GUIDEBOOK_IMPORT_TARGET=dev but DATABASE_URL points at the prod DB; refusing to run.");
    process.exit(1);
  }
} else {
  console.error("Set GUIDEBOOK_IMPORT_TARGET=dev or prod");
  process.exit(1);
}

async function main() {
  const dbMod = await import("@workspace/db");
  const { db, guidebookPages, pool } = dbMod;
  const { sql } = await import("drizzle-orm");
  const { runGuidebookImport, GUIDEBOOK_SOURCES } = await import("../lib/guidebookImport");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})`);
  console.log(`Configured sources: ${GUIDEBOOK_SOURCES.length}`);

  const before = await db.select({ n: sql<number>`count(*)::int` }).from(guidebookPages);
  console.log(`Existing pages before: ${before[0]?.n ?? 0}\n`);

  const result = await runGuidebookImport(null);
  console.log(
    `Import: created=${result.created} updated=${result.updated} unchanged=${result.unchanged} conflicts=${result.conflicts} errors=${result.errors}\n`,
  );
  for (const s of result.sources) {
    const tail = s.error ? ` — ${s.error}` : s.pageId ? ` (page #${s.pageId})` : "";
    console.log(`  [${s.status.toUpperCase().padEnd(9)}] ${s.section}/${s.title}${tail}`);
  }

  const after = await db.select({ n: sql<number>`count(*)::int` }).from(guidebookPages);
  console.log(`\nPages now: ${after[0]?.n ?? 0}`);
  await pool.end();
}

main().catch((err) => {
  console.error("import-guidebook failed:", err);
  process.exit(1);
});
