// One-off operational script: residual corrections to the "Detailed Systems
// Explanation" guidebook page (follow-up to the #210 wording cleanup, which was
// scoped to Discord-vs-on-site wording and left factual errors in place).
//
// Fixes on the detailed-systems page:
//   * Cyberware Points: the page states a 6 CWP creation cap up top but then
//     contradicts itself with "10 CWP" in the Exceeding/TL;DR/cyberpsychosis
//     lines. The canonical rule (see apply-task187-edits.ts) is 6 at creation,
//     15 lifetime max; the cyberpsychosis + maintenance tiers on this same page
//     use the 6/7 boundary. Align the stray "10"s to 6.
//   * Business ownership link still reads "Via the Google Sheet" (the sheet is
//     not how the website works) — point it at the on-site Property catalog.
//   * Typo: "begins uly 1st" -> "begins July 1st".
//   * Text RP: clarify that DMing NightCityBot happens in Discord.
//
// The page is flipped to editedSinceImport=true so a later re-import stashes
// incoming changes as a pendingImport instead of clobbering these. Edits are
// regex-based and idempotent: a missing target is logged as a warning (not a
// throw). These targets do not overlap with apply-task210-edits.ts, so the two
// scripts are order-independent on a fresh import.
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-detailed-systems-corrections.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-detailed-systems-corrections.ts

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

type Edit = { label: string; re: RegExp; to: string };

function applyEdits(body: string, edits: Edit[]): { body: string; applied: string[]; missing: string[] } {
  let out = body;
  const applied: string[] = [];
  const missing: string[] = [];
  for (const e of edits) {
    const next = out.replace(e.re, e.to);
    if (next !== out) {
      applied.push(e.label);
      out = next;
    } else {
      missing.push(e.label);
    }
  }
  return { body: out, applied, missing };
}

const DETAILED_SYSTEMS: Edit[] = [
  {
    label: "cyberware: exceeding-threshold 10 -> 6 CWP",
    re: /\*\*Exceeding initial 10 CWP:\*\*/,
    to: "**Exceeding your starting 6 CWP:**",
  },
  {
    label: "cyberware: cyberpsychosis-threshold 10 -> 6 CWP",
    re: /Going above 10 significantly increases cyberpsychosis risk\./,
    to: "Going above 6 significantly increases cyberpsychosis risk.",
  },
  {
    label: "cyberware: TL;DR start 10 -> 6 CWP",
    re: /\*\*10 CWP at start\*\*/,
    to: "**6 CWP at start**",
  },
  {
    label: "business: 'Via the Google Sheet' link -> Property catalog",
    re: /\[Via the Google Sheet\]\(\/catalog\/rent\)/,
    to: "[on the Property catalog](/catalog/rent)",
  },
  {
    label: "housing: 'uly 1st' typo -> July 1st",
    re: /Full rent enforcement begins uly 1st, 2025\./,
    to: "Full rent enforcement begins July 1st, 2025.",
  },
  {
    label: "text RP: clarify NightCityBot DM is in Discord",
    re: /### 📲 \*\*DM `NightCityBot`\*\* anytime with what your character wants to do\./,
    to: "### 📲 **DM `NightCityBot`** (in Discord) anytime with what your character wants to do.",
  },
];

const PAGE_EDITS: { slug: string; name: string; edits: Edit[] }[] = [
  { slug: "detailed-systems-explanation", name: "Detailed Systems", edits: DETAILED_SYSTEMS },
];

async function main() {
  const { db, guidebookPages } = await import("@workspace/db");
  const { pool } = await import("@workspace/db");
  const { eq } = await import("drizzle-orm");

  let host = "unknown";
  try {
    host = new URL(process.env.DATABASE_URL!).host;
  } catch {
    /* ignore */
  }
  console.log(`Target: ${host} (${target.toUpperCase()})\n`);

  for (const page of PAGE_EDITS) {
    const [row] = await db
      .select()
      .from(guidebookPages)
      .where(eq(guidebookPages.slug, page.slug));
    if (!row) {
      console.warn(`! ${page.name} (slug=${page.slug}) not found — run the guidebook import first. Skipping.`);
      continue;
    }
    const { body, applied, missing } = applyEdits(row.body, page.edits);
    if (applied.length === 0) {
      console.warn(`! ${page.name} (page #${row.id}): no edits matched (all ${page.edits.length} missing).`);
      for (const m of missing) console.warn(`    MISSING: ${m}`);
      continue;
    }
    await db
      .update(guidebookPages)
      .set({ body, editedSinceImport: true, updatedAt: new Date() })
      .where(eq(guidebookPages.id, row.id));
    console.log(`${page.name} (page #${row.id}): applied ${applied.length}/${page.edits.length} edits.`);
    for (const a of applied) console.log(`    ok: ${a}`);
    for (const m of missing) console.warn(`    MISSING: ${m}`);
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("apply-detailed-systems-corrections failed:", err);
  process.exit(1);
});
