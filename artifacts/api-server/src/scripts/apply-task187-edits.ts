// One-off operational script (Task #187): apply the protected on-site guidebook
// edits that must survive future re-imports. Run this AFTER re-running the
// guidebook import so it edits the freshly-imported bodies in place.
//
//   - FAQ: rewrite "How do I install Cyberware?" and "How do Cyberware Points
//     (CWP) work?" answers, and link the "full-borgs" answer to the new
//     Character Creation rules section.
//   - Detailed Systems: add the private text-RP channel to the "Want to RP with
//     other players?" answer.
//   - Create/refresh the Character Creation rules guidebook page.
//
// Each edited page is flipped to editedSinceImport=true so a later re-import
// stashes incoming changes as a pendingImport instead of clobbering these.
//
// Usage (from repo root):
//   GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task187-edits.ts
//   GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task187-edits.ts

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

const GUILD_ID = "1348601552083882108";
const REQUEST_RP_CHANNEL_ID = "1467905434936676615";
const FAQ_CHANNEL_ID = "1354586004601835700";
const SYSTEMS_CHANNEL_ID = "1384036684760616980";

// Replace a section that begins at `heading` and runs up to (but not including)
// its boundary — the nearest following `---` separator or next `## ` question
// heading, whichever comes first. The boundary marker is preserved. Throws if
// the heading isn't found so a wording drift surfaces loudly instead of
// silently no-op'ing.
function replaceSection(body: string, heading: string, newSection: string): string {
  const startIdx = body.indexOf(heading);
  if (startIdx === -1) throw new Error(`Section heading not found: ${JSON.stringify(heading)}`);
  const afterHeading = startIdx + heading.length;
  const idxSep = body.indexOf("\n---", afterHeading);
  const idxNext = body.indexOf("\n## ", afterHeading);
  const candidates = [idxSep, idxNext].filter((i) => i !== -1);
  const end = candidates.length ? Math.min(...candidates) : body.length;
  const prefix = body.slice(0, startIdx);
  const block = newSection.trim();
  if (end >= body.length) return `${prefix}${block}\n`;
  // body.slice(end) starts with the boundary's leading newline; drop just that
  // one so we control the spacing between our block and the boundary.
  const suffix = body.slice(end + 1);
  return `${prefix}${block}\n\n${suffix}`;
}

const FAQ_INSTALL = `
## 🛠️ **Q: How do I install Cyberware?**

### A: Cyberware is installed **in-character through a ripperdoc**, and your character's chrome is tracked for you on the website.

* **At character creation:** list the cyberware you want when you submit your character sheet for approval (start from the [New Character](/sheets/new) page). Approved chrome is added to your character automatically.
* **After creation:** book an IC visit with a **ripperdoc** to install something new. Once it's approved it appears in your character's loadout here, and your CWP total updates.

Each ripperdoc sets their **own IC pricing and RP standards**, so you'll arrange the visit with them. Browse what's available in the [Cyberware catalog](/catalog/cyberware), and see the [Character Creation rules](/guidebook#character_creation) for the limits.
`;

const FAQ_CWP = `
## 🧬 **Q: How do Cyberware Points (CWP) work?**

### A: Every piece of cyberware has a **CWP cost**. Your character's **total CWP** sets their cyberpsychosis-risk band and how much weekly medication they owe.

* You start with up to **6 CWP at character creation** — this is the creation cap.
* The hard cap is **15 CWP total**, reached over time through IC roleplay.
* **Aesthetic-only** cyberware (no mechanical benefit) costs **0 CWP**.
* **Custom** cyberware needs staff approval; a CWP value is assigned based on what it does.

**Risk bands (by total CWP):**

* **0–6 CWP — None:** 🟢 Stable. No cyberpsychosis risk and no weekly meds.
* **7–9 CWP — Medium:** 🟡 Risk begins. Keep up weekly checkups; skipping them ramps medication costs up to about \\$2,000/week.
* **10–12 CWP — High:** 🟠 Serious risk. Skipped checkups ramp costs up to about \\$5,000/week.
* **13–15 CWP — Extreme:** 🔴 Severe risk. Skipped checkups ramp costs up to about \\$10,000/week.

Going over 6 CWP means an **AOD can trigger cyberpsychosis** when your character is under stress. Getting a ripperdoc checkup resets the medication ramp.
`;

const FAQ_FULLBORGS = `
## 🤖 **Q: Are AI, full-borgs, or sentient machines allowed?**

### **A:** No. Full conversions ("full-borgs"), sentient machines, and AI player characters aren't allowed.

For what you *can* play — and the rest of the creation limits — read the [Character Creation rules](/guidebook#character_creation), then start your character from the [New Character](/sheets/new) page or the [#character-creation](/characters) channel.
`;

const CHARACTER_CREATION_BODY = `# 🧬 Character Creation Rules

Everything you need to build a character that fits Night City. Read this before you submit, then start your sheet from the [New Character](/sheets/new) page.

## ✅ The basics

* **PC only** — you're playing a person in Night City, not a quest-giver or a canon character.
* You must be **18+** and have your **VRChat and Discord accounts linked** before you play (see [VRChat / Discord Setup](/guidebook#setup)).
* Submit a **character sheet** for staff approval. Include your concept, backstory, stats, and photos of the avatar you plan to use.
* You can have **as many characters as you like** — be creative.

## 🚫 Not allowed

* **No full-borgs, sentient machines, or AI player characters.**
* **No canon characters** from *Cyberpunk 2077* (e.g. Johnny Silverhand, V, Judy). You may reference major corps or canon events, but this is a **custom story world**, not a remake.
* No "HIM"-style invincible power fantasies. Your character is mortal — play them that way.

## 🦾 Cyberware at creation

* You start with up to **6 CWP** (Cyberware Points) at creation — the creation cap. The lifetime hard cap is **15 CWP**, earned through IC roleplay.
* **Aesthetic-only** cyberware costs **0 CWP**. **Custom** cyberware needs staff approval and is assigned a CWP value based on function.
* Browse options in the [Cyberware catalog](/catalog/cyberware). For how points, risk bands, and medication work, see the FAQ's [Cyberware Points answer](/guidebook#faq).

## 🐾 Exotics

Exotics (animal features, robotic looks, full-body mods) are welcome — both **synthetic mods** and **biomods**. See the FAQ for how Exotics work in the setting.

## ✍️ Make it yours

This is a character-driven RP: the more developed your character, the better your experience. Need a hand? Check the **Character Building Guide** and **Character Concepts List** linked in the [FAQ](/guidebook#faq), or open a ticket in [#character-creation](/characters) to pitch a loose idea — we're happy to help shape it.
`;

async function resolveChannelName(channelId: string): Promise<string> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) return "request-rp";
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return "request-rp";
    const data = (await res.json()) as { name?: string };
    return data.name ?? "request-rp";
  } catch {
    return "request-rp";
  }
}

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

  // --- FAQ -----------------------------------------------------------------
  const [faq] = await db.select().from(guidebookPages).where(eq(guidebookPages.discordChannelId, FAQ_CHANNEL_ID));
  if (!faq) throw new Error("FAQ page not found — run the guidebook import first.");
  let faqBody = faq.body;
  faqBody = replaceSection(faqBody, "## 🛠️ **Q: How do I install Cyberware?**", FAQ_INSTALL);
  faqBody = replaceSection(faqBody, "## 🧬 **Q: How do Cyberware Points (CWP) work?**", FAQ_CWP);
  faqBody = replaceSection(faqBody, "## 🤖 **Q: Are AI, full-borgs, or sentient machines allowed?**", FAQ_FULLBORGS);
  await db
    .update(guidebookPages)
    .set({ body: faqBody, editedSinceImport: true, updatedAt: new Date() })
    .where(eq(guidebookPages.id, faq.id));
  console.log(`FAQ (page #${faq.id}): rewrote install + CWP + full-borgs answers.`);

  // --- Detailed Systems ----------------------------------------------------
  const channelName = await resolveChannelName(REQUEST_RP_CHANNEL_ID);
  const safeLabel = channelName.replace(/([\\[\]()<>])/g, "\\$1");
  const requestRpLink = `[#${safeLabel}](https://discord.com/channels/${GUILD_ID}/${REQUEST_RP_CHANNEL_ID})`;
  const SYSTEMS_RP = `
## 🧑‍🤝‍🧑 **Want to RP with other players?**
There are two ways to get a scene going between events:

* **DM \`NightCityBot\`** and we'll create a **private text RP channel** just for you and whoever else is involved.
* **Post in ${requestRpLink}** to find players and arrange text RP together.
`;
  const [systems] = await db.select().from(guidebookPages).where(eq(guidebookPages.discordChannelId, SYSTEMS_CHANNEL_ID));
  if (!systems) throw new Error("Detailed Systems page not found — run the guidebook import first.");
  const systemsBody = replaceSection(
    systems.body,
    "## 🧑‍🤝‍🧑 **Want to RP with other players?**",
    SYSTEMS_RP,
  );
  await db
    .update(guidebookPages)
    .set({ body: systemsBody, editedSinceImport: true, updatedAt: new Date() })
    .where(eq(guidebookPages.id, systems.id));
  console.log(`Detailed Systems (page #${systems.id}): added request-RP channel (#${channelName}).`);

  // --- Character Creation rules page ---------------------------------------
  const [existingCC] = await db
    .select()
    .from(guidebookPages)
    .where(eq(guidebookPages.section, "character_creation"));
  if (existingCC) {
    await db
      .update(guidebookPages)
      .set({
        title: "Character Creation Rules",
        description: "What you can and can't play, and the limits to build within.",
        body: CHARACTER_CREATION_BODY,
        editedSinceImport: true,
        updatedAt: new Date(),
      })
      .where(eq(guidebookPages.id, existingCC.id));
    console.log(`Character Creation (page #${existingCC.id}): refreshed body.`);
  } else {
    const [created] = await db
      .insert(guidebookPages)
      .values({
        section: "character_creation",
        title: "Character Creation Rules",
        slug: "character-creation-rules",
        description: "What you can and can't play, and the limits to build within.",
        body: CHARACTER_CREATION_BODY,
        position: 0,
        editedSinceImport: true,
      })
      .returning();
    console.log(`Character Creation (page #${created.id}): created.`);
  }

  await pool.end();
  console.log("\nDone.");
}

main().catch((err) => {
  console.error("apply-task187-edits failed:", err);
  process.exit(1);
});
