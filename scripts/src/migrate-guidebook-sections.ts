// Remap guidebook_pages.section from the legacy 9-key catalogue to the
// condensed onboarding-ordered 5-key catalogue (start_here / rules / setup /
// systems / reference), and flag the rules pages publicly readable so the
// logged-out Start Here page and Discord links can point at them.
// Idempotent — safe to re-run (runs from post-merge.sh so prod converges too).
import { db } from "@workspace/db";
import { sql } from "drizzle-orm";

const REMAP: Array<[string, string]> = [
  ["getting_started", "start_here"],
  ["faq", "start_here"],
  ["schedule", "systems"],
  ["npc_acting", "systems"],
  ["character_creation", "reference"],
  ["library", "reference"],
];

// Keep merged sections readable in a sensible order without colliding with the
// positions of the pages already in the target section.
const POSITION: Array<[string, number]> = [
  ["faq", 1],
  ["npc_acting", 4],
  ["schedule", 5],
];

async function main(): Promise<void> {
  for (const [section, pos] of POSITION) {
    await db.execute(sql`
      update guidebook_pages set position = ${pos}
      where section = ${section} and position <> ${pos}
    `);
  }
  for (const [from, to] of REMAP) {
    const r = await db.execute(sql`
      update guidebook_pages set section = ${to} where section = ${from}
    `);
    const n = (r as unknown as { rowCount?: number }).rowCount ?? 0;
    if (n > 0) console.log(`section ${from} -> ${to}: ${n} page(s)`);
  }
  const flagged = await db.execute(sql`
    update guidebook_pages set public_read = true
    where slug in ('rp-rules', 'avatar-restrictions') and public_read = false
  `);
  const fn = (flagged as unknown as { rowCount?: number }).rowCount ?? 0;
  if (fn > 0) console.log(`flagged ${fn} rules page(s) public`);
  console.log("guidebook section migration done");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
