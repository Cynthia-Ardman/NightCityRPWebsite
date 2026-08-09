// Idempotent data migration: mark onboarding guidebook pages as publicRead=true
// so anonymous visitors (newcomers who haven't joined yet) can read them before
// creating an account. These pages were previously only visible to logged-in
// users; the two rules pages (rp-rules, avatar-restrictions) were already public.
//
// Slugs covered:
//   getting-started-with-ncrp   — start_here
//   faq                         — start_here
//   vrchat-group-link           — setup
//   link-vrchat-discord         — setup
//   schedule-events             — systems
//   npc-acting                  — systems
//   detailed-systems-explanation — systems
//   character-creation-rules    — reference
//   strong-character-guide      — reference
//   character-concepts-list     — reference
//
// Safe to re-run: pages already flagged are skipped with a log line.
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/set-onboarding-pages-public.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/set-onboarding-pages-public.ts

export {};

const target = (process.env.GUIDEBOOK_IMPORT_TARGET ?? "").toLowerCase();
if (target === "prod") {
  if (!process.env.LIVE_PROD_DATABASE_URL) {
    console.error("GUIDEBOOK_IMPORT_TARGET=prod requires LIVE_PROD_DATABASE_URL; refusing to run.");
    process.exit(1);
  }
  process.env.DATABASE_URL = process.env.LIVE_PROD_DATABASE_URL;
} else if (target === "dev") {
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

// All slugs that should be publicRead. The existing rules pages are already
// public and are included here so the script is self-documenting; they will be
// skipped as no-ops when already flagged.
const PUBLIC_SLUGS: string[] = [
  // rules (already public — included for completeness)
  "rp-rules",
  "avatar-restrictions",
  // start_here
  "getting-started-with-ncrp",
  "faq",
  // setup
  "vrchat-group-link",
  "link-vrchat-discord",
  // systems
  "schedule-events",
  "npc-acting",
  "detailed-systems-explanation",
  // reference
  "character-creation-rules",
  "strong-character-guide",
  "character-concepts-list",
];

async function main() {
  const { db, guidebookPages, pool } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})\n`);

  const rows = await db
    .select({ id: guidebookPages.id, slug: guidebookPages.slug, title: guidebookPages.title, publicRead: guidebookPages.publicRead })
    .from(guidebookPages)
    .where(inArray(guidebookPages.slug, PUBLIC_SLUGS));

  const foundSlugs = new Set(rows.map((r) => r.slug));
  const missingSlugs = PUBLIC_SLUGS.filter((s) => !foundSlugs.has(s));
  if (missingSlugs.length > 0) {
    console.warn(`! ${missingSlugs.length} slug(s) not found in DB — run the guidebook import first:`);
    for (const s of missingSlugs) console.warn(`    missing: ${s}`);
  }

  const toUpdate = rows.filter((r) => !r.publicRead);
  const alreadyPublic = rows.filter((r) => r.publicRead);

  if (alreadyPublic.length > 0) {
    console.log(`Already public (${alreadyPublic.length} pages — no-op):`);
    for (const r of alreadyPublic) console.log(`  ✓ ${r.title} (slug=${r.slug})`);
  }

  if (toUpdate.length === 0) {
    console.log("\nAll target pages are already public. Nothing to update.");
  } else {
    const ids = toUpdate.map((r) => r.id);
    await db
      .update(guidebookPages)
      .set({ publicRead: true, updatedAt: new Date() })
      .where(inArray(guidebookPages.id, ids));
    console.log(`\nMarked public (${toUpdate.length} pages):`);
    for (const r of toUpdate) console.log(`  → ${r.title} (slug=${r.slug}, id=${r.id})`);
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("set-onboarding-pages-public failed:", err);
  process.exit(1);
});
