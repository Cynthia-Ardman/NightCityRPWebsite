# Night City RP Portal — Site Map

Generated from the live wouter route table in `App.tsx`.
Access tags: **PUBLIC** = no login required · **AUTH** = signed-in Discord user · **OWNER** = signed-in user must own the resource · **FIXER** / **RIPPER** / **SHOP** / **CS_APPROVER** / **ADMIN** = corresponding role required.

---

## 1. Public-facing (no login)

### `/`   — Home
*Splash + "Login via Discord" entry point.*
- Show current build tag (NIGHT_CITY_OS vX.Y.Z).
- One-click Discord OAuth login.
- Marketing copy describing the server.

### `/login/error`, `/logout/error`
*OAuth failure landings — display the error reason and a retry link.*

### `/directory/characters`   — Character Archive   **PUBLIC**
*Browse every approved character in the city.*
- Searchable / filterable grid (name, archetype, status).
- Portrait thumbnail, name, archetype, status badge per card.
- Click → public character detail.

### `/directory/characters/:id`   — Public Character Sheet   **PUBLIC**
*Read-only dossier for one character.*
- Portrait, name, archetype, verified / pending badge.
- Backstory / sheet sections (legacy anchors stripped before display).
- Portrait & stats-image galleries.
- Owner Discord handle (avatar + globalName + @username).
- No wallet, inventory, or status data exposed.

### `/directory/stores`, `/directory/stores/:id`   — Storefront Directory   **PUBLIC**
*See every player-run shop and what's on the shelves.*
- List page: shop name, owner, district, tagline.
- Detail page: stock list with name / category / price / qty; opening hours; staff list. No "Sell" button here — that lives in the owner view.

### `/directory/ripperdocs`, `/directory/ripperdocs/:id`   — Ripperdoc Directory   **PUBLIC**
*Same shape as the storefront directory but for cyberware clinics.*
- Catalog of installable chrome, prices, install fee, doc on duty.

### `/catalog/guns`   — Gun Catalog   **PUBLIC**
*Reference list of every weapon model and its baseline stats.*

### `/catalog/cyberware`   — Cyberware Catalog   **PUBLIC**
*Reference list of cyberware models, slots, humanity cost, baseline price.*

### `/catalog/rent`   — Housing Catalog   **AUTH** (login required to lease)
*Browse available residences across the districts.*
- District, address, tier, monthly rent.
- **Lease** button per row → modal: pick which of your characters signs the lease → calls `POST /housing/lease` and starts monthly rent debits via the cron.

---

## 2. Player area (any logged-in user)

### `/characters`   — My Characters   **AUTH**
*Hub for the characters you own.*
- Grid of your PCs / NPCs with status, last activity.
- "Create new character sheet" entry point.
- Quick links into each character.

### `/characters/:id`   — Character Workbench   **OWNER**
*The full owner-only command center for one of your characters. Tabbed.*

- **Profile tab**
  - Dossier: backstory + freeform sheet sections (whichever the sheet has).
  - Housing card: active leases with **Vacate** action (`DELETE /housing/:id`).
  - Portrait gallery + stats-image gallery.
- **Wallet tab** (UnbelievaBoat-backed)
  - Cash / Bank / Total balance.
  - **Transfer eddies** form: recipient picker + amount + memo → `POST /characters/:id/wallet/transfer`.
  - Ledger: paginated transaction history with kind, amount, counterparty, memo.
  - Graceful "wallet provider unavailable" state if UB is down.
- **Inventory tab**
  - Add item (name / category / qty / notes).
  - Per-item: edit, equip toggle, delete, **Move** (give or sell).
  - **Move** dialog: pick recipient character + qty + (sell-only) total price → `POST /characters/:cid/inventory/:itemId/transfer`. Atomic: UB transfer happens first; item only moves on success.
- **Status tab**
  - Health / wounded / dead / missing flags + notes → `PATCH /characters/:id/status`.

### `/sheets/new`, `/sheets/:id/edit`   — Character Sheet Editor   **AUTH / OWNER**
*Long-form form for writing or revising a character sheet.*
- Identity, archetype, dossier sections, portrait & stats image uploads (object-storage backed).
- "Submit for approval" → goes to the CS approver queue.

### `/sheets/:id`   — Sheet Detail   **AUTH**
*Read-only view of one submitted sheet, including approval state.*

### `/sheets/pending`   — Approval Queue   **CS_APPROVER**
*Reviewer dashboard for unapproved sheets.*
- Per-sheet: approve / reject + comment → `POST /sheets/:id/decision`.
- Approval/rejection echoes to the configured CS approval Discord channel.

### `/dice`   — Dice Roller   **AUTH**
*Server-side dice engine so rolls can't be faked.*
- Standard formula input (e.g. `2d10+3`).
- History list of your recent rolls (timestamped, with formula + result).

---

## 3. Role-gated business pages

### `/stores`   — My Stores   **SHOP**
*List of storefronts you own or work at.*

### `/stores/:id`   — Storefront Management   **SHOP** (must own / be employee)
*Run one of your shops.*
- Edit name, district, tagline, hours.
- Manage employees (add / remove).
- Manage stock rows (add / edit price & qty / delete).
- **Sell** button per stock row → modal: buyer character + qty → `POST /stores/:id/sell`. Atomically debits buyer, credits store owner via UB, decrements stock, and drops the item into the buyer's inventory.

### `/clinics`   — My Clinics   **RIPPER**
*List of ripperdoc clinics you own.*

### `/clinics/:id`   — Clinic Management   **RIPPER**
*Same shape as storefront management, but selling installs cyberware into the buyer's inventory via `POST /ripperdocs/:id/sell`.*

### `/fixer`   — Fixer Hub   **FIXER**
*Landing page for fixer tooling.*
- "My NPCs" list with quick links.
- "Missions" link.
- Aggregate stats (active NPCs, missions this month, payout total).

### `/fixer/npcs/:id`   — Fixer NPC Detail   **FIXER**
*Edit an NPC the fixer owns: name, role, district, notes, picture.*

### `/fixer/missions`   — Mission Log   **FIXER**
*Track gigs the fixer has run.*
- Table of missions: date, character, mission name, payout.
- New-mission form. Optionally debits the Fixer hub wallet and credits the participating character via UB on submit (`POST /fixer/missions`).

---

## 4. Admin area

### `/admin`   — Admin Dashboard   **ADMIN**
*One page, many tabs.*

- **Users tab** — every Discord user known to the portal.
  - Avatar + globalName + @username + raw Discord ID per row.
  - Role badges (ADMIN / FIXER / RIPPER / SHOP / CS_APPROVER).
  - Character count.
  - **Hydrate from Discord** (placeholders only) and **Force all** (re-hydrate everyone) buttons.
  - Click row → user detail page.
- **Characters tab** — every character in the city.
  - Search, filter by owner / approval / type.
  - **Reassign owner** (`PUT /admin/characters/:id/owner`) and **clear owner** actions.
- **Wallet tab** — admin wallet adjustment.
  - Pick character + amount (± allowed) + memo → `POST /admin/wallet/adjust`.
- **Jobs tab** — background-job control surface.
  - List registered jobs with last-run timestamp, next-run, status.
  - **Run now** button per job (`POST /admin/jobs/run`) — useful for kicking the monthly rent cron manually.
- **Activity tab** — the raw activity event firehose for quick eyeballing.
- **Audit tab** — filterable audit feed over `activity_events`.
  - Filter by kind (e.g. `transfer`, `lease`), actor user ID, since-timestamp.
  - Apply / refresh refetches.
- **System Flags tab** — `bot_config` k/v editor.
  - List, add, edit (JSON values), delete keys.
- **Stats tab** — high-level counts (users, characters, leases, jobs run, etc.).

### `/admin/users/:userId`   — Admin User Detail   **ADMIN**
*Drill-down for one Discord user.*
- Discord identity block (avatar, globalName, @username, ID).
- Role toggles (`POST /admin/users/:userId/roles`) — flip admin / fixer / ripper / shop owner / CS approver.
- List of characters they own with quick links.
- Recent activity for that user.

---

## 5. Catch-all

### `*` (any other path)   — 404 Not Found
*Cyberpunk-styled "ACCESS DENIED — signal lost" page with a link home.*

---

## Cross-cutting building blocks (not pages, but worth knowing)

- **Layout shell** — left sidebar with Personal / Directory / Catalogs / (role-gated) Business / Admin sections; "Login via Discord" sits in the bottom rail when logged out.
- **Discord identity** — `id == discord_id` for every user; UI consistently shows avatar + globalName + @username so the same person is recognizable across pages.
- **UnbelievaBoat wallet** — single source of truth for eddies. Every player-visible money move (transfer, sell, lease, mission payout, admin adjust) goes through it and lands in `activity_events` for the audit feed.
- **Object storage** — portraits and sheet images live in App Storage; URLs are served via `/api/storage/objects/*` so the portal SPA doesn't shadow them.
- **Cron jobs** — monthly rent biller, sheet-approval reminders, audit pruner. All manually triggerable from Admin → Jobs.
