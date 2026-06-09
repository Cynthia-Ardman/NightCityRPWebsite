// One-off operational script (Task #210): guidebook + lore wording cleanup.
// Imported pages still describe Discord-only flows for things that now live on
// the portal. This rewrites that wording to point at the on-site equivalents,
// keeps genuine Discord-only references but makes clear they live in Discord,
// and fixes a raw `<#id>` mention in lore.
//
// Each edited guidebook page is flipped to editedSinceImport=true so a later
// re-import stashes incoming changes as a pendingImport instead of clobbering
// these. (Lore has no such flag — see docs/guidebook-wording-cleanup.md.)
//
// Run this AFTER re-running the guidebook import so it edits the freshly-imported
// bodies in place. Edits are regex-based and idempotent: a missing target is
// logged as a warning (not a throw) so dev/prod content drift surfaces without
// aborting the rest of the run.
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task210-edits.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task210-edits.ts

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

// Apply each edit, comparing before/after so we can report exactly which targets
// matched. Returns the new body plus the applied/missing labels.
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

// --- Per-page edit sets ----------------------------------------------------

const GETTING_STARTED: Edit[] = [
  {
    label: "ticket-creation heading -> on-site",
    re: /## \*\*🎟️ Ticket Creation\*\*/,
    to: "## **🎟️ Create & Request (on the website)**",
  },
  {
    label: "character-creation entry -> on-site",
    re: /\* \*\*\[#character-creation\]\(\/characters\)\*\*: Submit your NCRP character for approval\./,
    to: "* **[Create a character](/characters)**: Submit your character for approval on the website (start a new sheet from [New Character](/sheets/new)).",
  },
  {
    label: "business-creation entry -> on-site",
    re: /\* \*\*\[#business-creation\]\(\/catalog\/rent\)\*\*: Submit your businesses for approval within NCRP\./,
    to: "* **[Property catalog](/catalog/rent)**: Submit a business for approval on the website.",
  },
  {
    label: "request-lease entry -> on-site",
    re: /\* \*\*\[#request-lease-or-rental\]\(\/catalog\/rent\)\*\*: Apply for property leases or rentals\./,
    to: "* **[Property catalog](/catalog/rent)**: Apply for property leases or rentals on the website.",
  },
  {
    label: "reports-and-questions entry -> clarify Discord",
    re: /\* \*\*\[#reports-and-questions\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1349160087322624102\)\*\*: Report issues or ask questions directly to staff\./,
    to: "* **#reports-and-questions** (in Discord): Report issues or ask questions directly to staff.",
  },
];

const FAQ: Edit[] = [
  {
    label: "make-a-character start -> on-site",
    re: /### A: Start by checking out the \[#character-creation\]\(\/characters\)\s*channel\. Read the restrictions and review the character sheet template\./,
    to: "### A: Head to the [Characters](/characters) page and start a new sheet from [New Character](/sheets/new). Read the restrictions and review the character sheet template.",
  },
  {
    label: "make-a-character submit -> on-site",
    re: /Then, click the button in the channel to open a character ticket\. Submit your sheet there along with photos of the avatar you plan to use\./,
    to: "Fill out and submit your character sheet on the website, along with photos of the avatar you plan to use.",
  },
  {
    label: "eddies: buy an apartment -> on-site",
    re: /Buy an apartment \[#request-lease-or-rental\]\(\/catalog\/rent\)/,
    to: "Buy an apartment on the [Property catalog](/catalog/rent)",
  },
  {
    label: "eddies: start a business -> on-site",
    re: /Start a business \[#business-creation\]\(\/catalog\/rent\)/,
    to: "Start a business on the [Property catalog](/catalog/rent)",
  },
  {
    label: "get cyberware -> on-site",
    re: /### A: Open a \*\*character ticket\*\* and list the cyberware you want\./,
    to: "### A: List the cyberware you want on your character sheet (start from the [New Character](/sheets/new) page).",
  },
  {
    label: "install cyberware -> on-site",
    re: /### A: Cyberware must be \*\*installed IC\*\* by a \*\*ripperdoc\*\* \(After character creation\) or mentioned in your \[#character-creation\]\(\/characters\) ticket\./,
    to: "### A: Cyberware must be **installed IC** by a **ripperdoc** (after character creation), or listed on your character sheet at creation via the [Characters](/characters) page.",
  },
  {
    label: "retcon: reports-and-questions -> clarify Discord",
    re: /\[#reports-and-questions\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1349160087322624102\)/g,
    to: "Discord's **#reports-and-questions** channel",
  },
];

const RP_RULES: Edit[] = [
  {
    label: "react-to-rules -> clarify Discord",
    re: /# YOU MUST REACT TO THE RULES BELOW WITH 🫡\s*TO JOIN RP/,
    to: "# In Discord, you must react to the rules post with 🫡 to gain access to RP.",
  },
  {
    label: "social-ping -> clarify Discord",
    re: /If you wish to be pinged for our \*\*Social RP's\*\* please click 🟢/,
    to: "In Discord, react with 🟢 to be pinged for our **Social RP's**.",
  },
  {
    label: "main-session-ping -> clarify Discord",
    re: /If you wish to be pinged for our \*\*Main Sunday Session\*\* please click 💜/,
    to: "In Discord, react with 💜 to be pinged for our **Main Sunday Session**.",
  },
];

const DETAILED_SYSTEMS: Edit[] = [
  {
    label: "housing eviction -> clarify Discord + status link",
    re: /\* If you cannot pay your rent, you'll receive an @ mention in the[^\n]*eviction-notices[^\n]*channel\./,
    to: "* If you cannot pay your rent, you'll be notified in Discord's **#eviction-notices** channel — you can check your standing on the [Property catalog](/catalog/rent).",
  },
  {
    label: "secure housing -> on-site",
    re: /Open a ticket via \[#request-lease-or-rental\]\(\/catalog\/rent\)/,
    to: "Request a home or apartment on the [Property catalog](/catalog/rent) page",
  },
  {
    label: "earn-money commands -> clarify Discord",
    re: /\* Use the !work, !slut, or,? !crime commands/,
    to: "* Earn through Discord economy commands like `!work`, `!crime`, and `!slut` (run in Discord).",
  },
  {
    label: "reports-and-questions (x2) -> clarify Discord",
    re: /\[#reports-and-questions\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1349160087322624102\)/g,
    to: "**#reports-and-questions** (in Discord)",
  },
  {
    label: "business eviction -> clarify Discord",
    re: /\* If you cannot pay, you'll be @ mentioned in \[#eviction-notices\][^\n]*7-day grace period\*\*\./,
    to: "* If you cannot pay, you'll be notified in Discord's **#eviction-notices** channel and given a **7-day grace period**.",
  },
  {
    label: "open shop -> on-site Home",
    re: /\* Press the `open_shop` button in[^\n]*on Sundays\./,
    to: "* Open your shop from the [Home page](/) during the Sunday session window.",
  },
  {
    label: "business creation submit -> on-site",
    re: /\* Use [^\n]*\[#business-creation\]\(https:\/\/discord\.com[^\n]*channel\./,
    to: "* Submit it on the [Property catalog](/catalog/rent) page.",
  },
  {
    label: "lease requests submit -> on-site",
    re: /\* Submit via \[#request-lease-or-rental\]\(\/catalog\/rent\)/,
    to: "* Submit a lease request on the [Property catalog](/catalog/rent) page",
  },
  {
    label: "business open-a-ticket -> on-site",
    re: /Open a ticket via \[#business-creation\]\(\/catalog\/rent\)\s*to claim property, establish a business, or clarify your business needs\./,
    to: "Head to the [Property catalog](/catalog/rent) page to claim property, establish a business, or clarify your business needs.",
  },
  {
    label: "custom cyberware -> on-site",
    re: /To submit a custom cyberware please create a character ticket here: \[#character-creation\]\(\/characters\)/,
    to: "To submit a custom cyberware request, include it on your character sheet from the [New Character](/sheets/new) page (or your character's page).",
  },
  {
    label: "attendance -> on-site Home",
    re: /\* Press the __Attend__ Button in \[#player-hub\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1489585217558806658\)[^\n]*/,
    to: "* Use the **Attend** button on the [Home page](/) during a live session.",
  },
  {
    label: "trauma payment notifications -> clarify Discord",
    re: /\[#trauma-team-payment-plans\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1351070651313557545\)/,
    to: "Discord's **#trauma-team-payment-plans** channel",
  },
  {
    label: "trauma plan signups (x2) -> clarify Discord",
    re: /\[#trauma-team-plan-signups\]\(https:\/\/discord\.com\/channels\/1348601552083882108\/1349547345431498875\)/g,
    to: "Discord's **#trauma-team-plan-signups** channel",
  },
];

const PAGE_EDITS: { slug: string; name: string; edits: Edit[] }[] = [
  { slug: "getting-started-with-ncrp", name: "Getting Started", edits: GETTING_STARTED },
  { slug: "faq", name: "FAQ", edits: FAQ },
  { slug: "rp-rules", name: "RP Rules", edits: RP_RULES },
  { slug: "detailed-systems-explanation", name: "Detailed Systems", edits: DETAILED_SYSTEMS },
];

// --- Lore: fix a raw `<#id>` mention that points at a dead Discord forum thread
// (no portal equivalent), turning it into a clean Discord deep-link.
const LORE_RAW_MENTION = "<#1379249876403097721>";
const LORE_MENTION_REPLACEMENT =
  "the [original Discord thread](https://discord.com/channels/1348601552083882108/1379249876403097721)";

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

  // --- Guidebook pages -----------------------------------------------------
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

  // --- Lore: raw <#id> -> Discord deep-link --------------------------------
  const loreRes = await pool.query(
    `UPDATE lore_entries
        SET summary = REPLACE(summary, $1, $2),
            public_body = REPLACE(public_body, $1, $2),
            fixer_body = CASE WHEN fixer_body IS NULL THEN NULL ELSE REPLACE(fixer_body, $1, $2) END,
            updated_at = now()
      WHERE summary LIKE '%' || $1 || '%'
         OR public_body LIKE '%' || $1 || '%'
         OR fixer_body LIKE '%' || $1 || '%'`,
    [LORE_RAW_MENTION, LORE_MENTION_REPLACEMENT],
  );
  console.log(`\nLore: rewrote raw <#id> mention in ${loreRes.rowCount} entr${loreRes.rowCount === 1 ? "y" : "ies"}.`);

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("apply-task210-edits failed:", err);
  process.exit(1);
});
