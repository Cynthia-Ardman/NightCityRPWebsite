# Guidebook & Lore Wording Cleanup (Task #210)

Guidebook and lore pages are imported from Discord, so they still described
**Discord-only flows** for things that now live on the portal (e.g. "press the
`open_shop` button in #player-hub", "open a character ticket"). This pass
rewrites that wording to describe the **on-site equivalents** and points readers
at the correct portal pages. Genuine Discord-only references (RP channels, bot
DMs, reactions) were kept but reworded so it's clear they live in Discord.

All page edits are applied as **protected on-site edits** (`editedSinceImport =
true`) so a future Discord re-import stashes the incoming version as a
`pendingImport` for review instead of clobbering these changes.

## How to apply

Run **after** the guidebook import so it edits freshly-imported bodies:

```bash
# dev
GUIDEBOOK_IMPORT_TARGET=dev  pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task210-edits.ts
# prod (requires LIVE_PROD_DATABASE_URL in the environment)
GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-task210-edits.ts
```

The script is regex-based and idempotent. It reports `applied`/`MISSING` per
edit; a `MISSING` warning means the target wording drifted (re-check before
trusting that page). As of this writing it applies **28/28** edits on dev.

## Importer mapping change

`artifacts/api-server/src/lib/guidebookImport.ts` — added to `CHANNEL_PORTAL_LINKS`:

| Channel | ID | Portal destination | Why |
| --- | --- | --- | --- |
| `#player-hub` | `1489585217558806658` | `/` (Home) | Home hosts the **Attend** and **Open Shop** buttons (session-gated Sun 2–9pm Pacific). |

This means future imports rewrite `#player-hub` channel refs to the portal Home
automatically. The other Discord channels referenced below have **no** portal
home and are deliberately left as Discord links.

## Changed pages

### Getting Started (`getting-started-with-ncrp`, page #1)
- "🎟️ Ticket Creation" heading → "🎟️ Create & Request (on the website)".
- `#character-creation` / `#business-creation` / `#request-lease-or-rental`
  entries reworded to describe creating/requesting **on the website**
  (Characters / Property catalog / New Character).
- `#reports-and-questions` clarified as a Discord channel.

### FAQ (`faq`, page #2)
- "How do I make a character?" → start a sheet from **New Character**, submit on
  the website (was: "click the button in the channel to open a character ticket").
- "How do I make eddies?" → buy an apartment / start a business links point to
  the **Property catalog**.
- "How do I get Cyberware?" / "How do I install Cyberware?" → list cyberware on
  your character sheet (was: "open a character ticket").
- "Can I retcon…?" → `#reports-and-questions` clarified as Discord.

### RP Rules (`rp-rules`, page #3)
- "YOU MUST REACT … WITH 🫡" and the 🟢 / 💜 ping opt-ins reworded to make clear
  they are **Discord** reactions (there is no on-site equivalent).

### Detailed Systems (`detailed-systems-explanation`, page #10)
- Housing & business **lease / "secure housing" / "open a ticket"** flows →
  **Property catalog** (`/catalog/rent`).
- **Open Shop** and **Attend** → the **Home page** (`/`) during the Sunday
  session window (was: buttons in `#player-hub`).
- Custom cyberware "create a character ticket" → list it on your character sheet.
- `#eviction-notices`, `#reports-and-questions`, `#trauma-team-*` and the
  `!work`/`!crime`/`!slut` economy commands clarified as living in Discord.

### Lore — "Origin of Message to Nobody"
- A raw `<#1379249876403097721>` mention (which rendered literally on the site)
  was rewritten to a clean Discord deep-link. That channel is a **forum thread**
  with no portal equivalent, and the entry already contains the referenced
  content inline.

## Kept as Discord (genuine, no portal equivalent)

These were reworded for clarity but intentionally still point at Discord:

- `#eviction-notices` — rent/eviction notifications (status is also viewable on
  `/catalog/rent`).
- `#reports-and-questions` — staff support / OOC tickets.
- `#trauma-team-plan-signups`, `#trauma-team-payment-plans`,
  `#trauma-team-plan-information` — Trauma Team plan signup/billing.
- `#banking`, `#crime-and-work`, `#gambling` + `!work` / `!crime` / `!slut` —
  Discord economy commands.
- `#pooling-comm`, `#admin-announcements`, `#nc-change-log`,
  `#n1rvana-nightclub-info` — Discord announcement / venue channels.
- DM `NightCityBot` for text RP — Discord/bot flow.

## Flagged for source-side / pipeline follow-up

- **Discord sources should be updated too.** The on-site wording now diverges
  from the original Discord posts for: housing/business leasing, open-shop,
  attendance, character creation, and custom cyberware. The Discord channels
  (#detailed-systems-explanation, #getting-started, #faq, #rp-rules) still tell
  players to use Discord tickets/buttons — update them at the source so the two
  surfaces agree.
- **Lore importer does not rewrite `<#id>` mentions** and lore entries have no
  `editedSinceImport` protection. The entry-48 fix above is a direct data edit
  and **will be clobbered** if that lore draft is re-imported and re-published.
  If raw channel mentions become common in lore, the lore import pipeline should
  gain the same `<#id>` rewriting (and a protected-edit guard) as the guidebook
  importer.

## Follow-up corrections — Detailed Systems Explanation page

The #210 pass was scoped to Discord-vs-on-site wording and left a few **factual
errors** on the `detailed-systems-explanation` page in place. These are fixed by
`apply-detailed-systems-corrections.ts` (same protected-edit pattern:
`GUIDEBOOK_IMPORT_TARGET=dev|prod`, sets `editedSinceImport=true`). Its regex
targets do not overlap with `apply-task210-edits.ts`, so the two are
order-independent on a fresh import.

- **Cyberware Points contradiction.** The page states a **6 CWP** creation cap up
  top, but the Exceeding/TL;DR/cyberpsychosis lines said **10**. Canonical rule
  (see `apply-task187-edits.ts`) is 6 at creation, 15 lifetime max; the
  cyberpsychosis and maintenance tiers on this same page already use the 6/7
  boundary. The three stray "10"s are now aligned to 6.
- **"Via the Google Sheet"** link text (business ownership status) → "on the
  Property catalog" (the sheet is not how the website works; the link already
  pointed at `/catalog/rent`).
- **Typo** "Full rent enforcement begins uly 1st" → "July 1st".
- **Text RP** — "DM `NightCityBot`" now marked "(in Discord)" so website readers
  know it is a Discord/bot flow (the `!work`/`!crime`/`!slut` economy commands
  remain marked as Discord, unchanged).

Prod run (after a re-import):
`GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-detailed-systems-corrections.ts`

## Follow-up corrections — "button below" / "ticket above" spatial refs

Two more imported pages used Discord-UI spatial phrasing that makes no sense on
the website. Fixed by `apply-guidebook-button-ref-fixes.ts` (same protected-edit
pattern). These two pages are mirror cases:

- **link-vrchat-discord** — genuinely Discord. VRChat linking is the VRCLinking
  *bot* flow (the portal only reads the resulting Verified 18+ role). "Click the
  button below" → "click the **link account** button on the VRCLinking bot in
  Discord"; "use the ticket above" → "open a VRCLinking Help Ticket in Discord".
- **npc-acting** — the opposite: the portal *does* render a real "Become an NPC"
  button on this page (`GuidebookPageDetail` injects
  `<BecomeNpcButton variant="guidebook">` for slug `npc-acting`, above the body).
  So "Click the NPC button below" / "Click the button below to receive the NPC
  role" → "Use the \"Become an NPC\" button at the top of this page". (Wording
  says "at the top" because the injected button renders above the markdown body.)

Prod run (after a re-import):
`GUIDEBOOK_IMPORT_TARGET=prod pnpm --filter @workspace/api-server exec tsx src/scripts/apply-guidebook-button-ref-fixes.ts`
