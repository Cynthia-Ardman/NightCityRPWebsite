// One-off operational script: fix Discord-only spatial UI references
// ("click the button below", "use the ticket above") on two imported guidebook
// pages that make no sense on the website.
//
//   * link-vrchat-discord — VRChat linking is a Discord/bot flow (the VRCLinking
//     bot lives in Discord; the website only reads the resulting Verified 18+
//     role). The "button below" / "ticket above" refer to that bot's button and
//     a Discord support ticket, so clarify they live in Discord.
//   * npc-acting — this one is the opposite: the portal DOES render a real
//     "Become an NPC" button on this page (GuidebookPageDetail injects
//     <BecomeNpcButton variant="guidebook"> for slug npc-acting, above the body).
//     So point the text at that on-site button instead of a Discord button.
//
// Each edited page is flipped to editedSinceImport=true so a later re-import
// stashes incoming changes as a pendingImport instead of clobbering these.
// Edits are regex-based and idempotent: a missing target is logged as a warning
// (not a throw).
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-guidebook-button-ref-fixes.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-guidebook-button-ref-fixes.ts

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

// link-vrchat-discord: genuine Discord/bot flow — clarify the references.
const LINK_VRCHAT: Edit[] = [
  {
    label: "vrchat: 'click the button below' -> VRCLinking bot in Discord",
    re: /To link your VRChat account, click the button below\./,
    to: "To link your VRChat account, click the **link account** button on the VRCLinking bot in Discord.",
  },
  {
    label: "vrchat: 'use the ticket above' -> open a Discord help ticket",
    re: /If you are having difficulty linking your account, or having technical issues please use the ticket above for support\./,
    to: "If you are having difficulty linking your account, or having technical issues, please open a VRCLinking Help Ticket in Discord for support.",
  },
];

// npc-acting: the portal renders a real "Become an NPC" button on this page —
// point the text at it instead of a Discord button.
const NPC_ACTING: Edit[] = [
  {
    label: "npc: 'NPC button below' -> on-site Become an NPC button",
    re: /👇 \*\*Click the NPC button below to claim your role and start contributing today!\*\*/,
    to: '**Use the "Become an NPC" button at the top of this page to claim your role and start contributing today!**',
  },
  {
    label: "npc: 'button below to receive role' -> on-site button",
    re: /Click the button below to receive the NPC role\./,
    to: 'Use the "Become an NPC" button at the top of this page to receive the NPC role.',
  },
];

const PAGE_EDITS: { slug: string; name: string; edits: Edit[] }[] = [
  { slug: "link-vrchat-discord", name: "Link VRChat & Discord", edits: LINK_VRCHAT },
  { slug: "npc-acting", name: "NPC Acting", edits: NPC_ACTING },
];

async function main() {
  const { db, guidebookPages, pool } = await import("@workspace/db");
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
  console.error("apply-guidebook-button-ref-fixes failed:", err);
  process.exit(1);
});
