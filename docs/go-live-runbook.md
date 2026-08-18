# Night City RP Portal — Go-Live Runbook

This is the operational checklist for taking the NCRP portal from the Test
environment to a live production deployment that moves **real** UnbelievaBoat
(UB) eddies and writes to the **real** Discord server.

It has three parts:

1. **Pre-deploy readiness checklist** — what must be true before you click Publish.
2. **Live smoke test** — an ordered, low-risk walkthrough that exercises every
   surface that can only be verified once real external writes are turned on,
   using a throwaway test character, tiny amounts, and full cleanup.
3. **Abort / rollback plan** — how to stop the bleeding and undo damage if a step
   misbehaves.

> **Read this first — the safety model.** A freshly deployed environment does
> **not** move real money or perform system-level Discord effects (payout posts,
> DMs, eviction notices, scheduled-event mirroring) until an admin explicitly
> turns systems on. **One exception:** a few **Discord role writes are not behind
> the Test/Live switchboard** — see the note under the table. There are three
> independent gates. Understanding them is the whole game:
>
> | Gate | Where | Default | What it controls |
> |---|---|---|---|
> | **A. External-write capability** | `externalWritesAllowed()` in `lib/discord.ts` — true when `REPLIT_DEPLOYMENT==='1'` (i.e. published) **or** `ALLOW_EXTERNAL_WRITES==='1'` | **ON in production** (deploys set `REPLIT_DEPLOYMENT=1`) | Whether the process is even *allowed* to call Discord writes (role grant/remove, channel posts, DMs, scheduled events) and UB `patchBalance`. Discord reads and UB `getBalance` are never gated. |
> | **B. Test/Live switchboard** | `bot_config`: `master_live_mode` + per-system `<sys>_live_mode` (missions, housing, cyberware, evictions, economy) | **all OFF (Test)** | Whether each system performs real effects. A system is Live only when **master AND its own switch** are both ON. In Test it logs/records what it *would* do. **This is your real safety control in production**, because Gate A is on by default once deployed. |
> | **C. Cron kill switches** | `bot_config`: `housing_autobill_enabled`, `cyberware_autobill_enabled`, `mission_autopay_enabled`, `economy_enabled` | **all OFF** | Whether the **scheduled** (cron) version of a job is allowed to fire. Manual `/admin/jobs/run` **bypasses** these by design — but a manual run still obeys Gate B, so it makes no live changes while the system is in Test. |
>
> **Note — Discord role writes bypass Gate B.** The Test/Live switchboard only
> governs systems/jobs wired through `isSystemLive` (missions, housing, cyberware,
> evictions, economy). It does **not** gate Discord *role* writes:
> - `role_sync` (cron every 6h, also runnable from Admin → Jobs) reconciles
>   Discord roles ↔ portal gate flags with **no** Test/Live gate — once deployed
>   (Gate A on) it performs real role grants/revokes.
> - `/auth/accept-rules` grants the rules-role on first login, independent of
>   live-mode.
>
>   So "turn master OFF" stops money + system-level posts/DMs/events, but role
>   reconciliation still runs. Plan for this when you publish (it is generally
>   desirable — it keeps the 18+/rules gates honest — but be aware it is live the
>   moment you deploy).
>
> **Consequence for go-live:** because Gate A is automatically ON in a deployment,
> the only thing standing between a fresh deploy and real *money* movement is the
> Test/Live switchboard (Gate B), which defaults to Test. **Never flip master Live
> until the readiness checklist passes**, and enable systems **one at a time**.

---

## Part 1 — Pre-deploy readiness checklist

Work top-to-bottom. Do not Publish until every box is checked.

### 1.1 Required production secrets / env vars

These are read by the api-server at runtime. Set them as **deployment** secrets
(the published app has its own secret scope). Do not print or paste secret values
anywhere; set them through the Replit Secrets UI.

**Hard-required (app fails or core flows break without them):**

- `DATABASE_URL` — production Postgres (provided by Replit's managed DB).
- `SESSION_SECRET` — **app refuses to boot without it** (`app.ts` throws). Use a
  long random value; do not reuse the dev value.
- `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` — OAuth login.
- `DISCORD_GUILD_ID` — the live server; all role/member/event operations target it.
- `DISCORD_BOT_TOKEN` (or legacy `TOKEN`) — bot token used for every Discord write
  and for reads (roles, DMs, posts, scheduled events).
- `UNBELIEVABOAT_TOKEN` (or legacy `UNBELIEVABOAT_API_TOKEN`) — UB currency API.
- `PUBLIC_BASE_URL` — canonical public URL of the portal; used to build links in
  Discord posts/DMs and OAuth redirects. Must be the **production** URL.
- Object storage: `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PRIVATE_OBJECT_DIR`,
  `PUBLIC_OBJECT_SEARCH_PATHS` — image upload/serving.

**Channel / behavior config (features silently no-op if missing):**

- `CS_APPROVAL_CHANNEL_ID` — character-sheet/edit/breach approval posts.
- `EVICTION_CHANNEL_ID` — eviction notices (sweep still deletes leases if unset;
  it just won't post).
- `HOUSING_GRACE_DAYS` — optional; eviction grace window (has a code default).

**Must be OFF / absent in production:**

- `ENABLE_TEST_AUTH` — **must be unset or not `true`**. The `/auth/test-login`
  back door is double-gated (also disabled whenever `NODE_ENV==='production'`,
  which deployments set), but do not rely on a single gate — confirm it is not set.
- `ALLOW_EXTERNAL_WRITES` — **do not set in production.** It is the dev/staging
  override for Gate A; deployments already enable external writes via
  `REPLIT_DEPLOYMENT=1`, so setting it adds nothing and only muddies intent.

> Verification: after deploy, hitting `/auth/test-login` on the production URL must
> return **404** (the endpoint is hard-disabled when `NODE_ENV==='production'`) —
> never a session. (It returns 403 only in a non-prod env where test auth is
> enabled but the userId lacks the `e2e-` prefix.)

### 1.2 Production database schema parity

The production schema is managed by **versioned Drizzle migrations** (see
"Database migrations" in `replit.md`), superseding the earlier Publish-diff
guidance.

- Schema changes ship as generated files in `lib/db/migrations/` committed with
  the schema edit.
- On production deploy, the api-server applies pending migrations at boot,
  before serving (advisory-locked; a failed migration aborts startup).
- The append-only history guards (DB triggers on `bot_*`/audit/activity tables)
  are re-applied by the post-merge `db:guards` step; confirm they exist in prod
  after major schema work (a quick read-only check that the triggers are present).

> If, after deploy, the app logs `column ... does not exist` / `relation ... does
> not exist`, a migration is missing — generate one from the schema diff and
> redeploy; do not patch prod directly.

### 1.3 Pre-flight verification (still in Test)

- ✅ Backend test suite (Task #206) green from its documented single command.
- ✅ Playwright e2e suite (Task #207) green against the Test environment.
- ✅ `getDeploymentInfo()` reviewed; you know the production URL and that the build
  is healthy after publishing.
- ✅ You have an **admin** account on the live Discord server and can reach
  `/admin` (live-mode switchboard, jobs, bot-config) on the production portal.
- ✅ A **throwaway test character** plan is ready: a character you own, with a
  known Discord account you control, so DMs and UB changes land somewhere you can
  see and clean up.

### 1.4 The flag-flip order (do this AFTER publish, not before)

All switches live in `bot_config` and are flipped from **Admin → Test/Live**
(`PUT /admin/live-mode`) and **Admin → bot-config** (`PUT /admin/bot-config/:key`).
Every flag reads live per-action, so flips take effect immediately.

1. **Publish** the app. At this point Gate A is on but every system is still Test
   (Gate B all OFF) — nothing moves yet.
2. Run the **live smoke test** (Part 2) one system at a time. For each system:
   flip `master_live_mode` ON (once), then that one system's switch ON, test it,
   verify, then proceed to the next.
3. Leave **cron kill switches (Gate C) OFF** until you have manually smoke-tested
   the corresponding job. Only enable `housing_autobill_enabled`,
   `cyberware_autobill_enabled`, `mission_autopay_enabled`, `economy_enabled` when
   you actually want the automatic schedule running.

> **Order matters:** master must be ON for any per-system switch to have effect
> (`isSystemLive = master && system`). Flip master once, then toggle systems
> individually so only the surface you are actively testing can move real data.

---

## Part 2 — Live smoke test

**Goal:** prove each live-only surface works against real UB + real Discord, with
the smallest possible blast radius, then clean up.

**Ground rules:**

- Use the throwaway test character and a Discord account you control.
- Use **tiny amounts** (e.g. €$1) everywhere money moves.
- After each step, verify in **both** places: the **portal** (ledger/balance/state)
  **and** the **external system** (UB balance via the bot, or the Discord channel/DM).
- Enable exactly one system at a time; return it to Test when you're done with it
  if you're not ready for players.
- These are the surfaces the automated suites (Tasks #206/#207) explicitly could
  **not** verify, because they require real external writes.

### Step 0 — Baseline (no flags on yet)

- Log in on production with your admin Discord account (real OAuth, not test-login).
- Confirm the **first-login rules gate** appears for a brand-new account and that
  "I've read the rules" clears it. *(Live-only nuance: accepting the rules also
  grants the Discord rules-role — that grant is a real Discord write and only
  happens in a deployment. Verify the role actually appears on the member in
  Discord.)*
- Note your test character's starting UB balance (ask the bot in Discord).

### Step 1 — Economy: wallet transfer (system: `economy`)

1. Flip `master_live_mode` ON and `economy_live_mode` ON.
2. Also set `economy_enabled` = true (the economy kill switch; required for any
   economy processing — note economy is tri-state: disabled / test / **enabled**).
3. In the portal, transfer **€$1** from your test character to a second character
   you control (or to the store/account as applicable).
4. **Verify portal:** both wallets' balances and the new `wallet_transactions`
   ledger rows.
5. **Verify UB:** ask the bot for both balances — the €$1 actually moved.
6. **Cleanup:** transfer the €$1 back.

### Step 2 — Commerce: purchase / sale / venue funds (system: `economy`)

1. With economy Live, open a shop on the test character, add one cheap stock item
   (€$1), and **buy** it with a second character.
2. **Verify portal:** buyer debited, seller/venue credited, stock decremented,
   ledger rows present.
3. **Verify UB:** buyer's real UB balance dropped by €$1.
4. Do one **sell-back / sale offer** and one **venue-funds transfer** the same way.
5. **Cleanup:** reverse the balances; remove the test stock; close the shop.

### Step 3 — Cyberware / ripperdoc (system: `cyberware`)

1. Flip `cyberware_live_mode` ON (master already ON).
2. On the test character, do a ripperdoc **install** of a cheap item (real UB
   charge) and confirm the CWP/humanity changes.
3. **Verify portal:** charge ledger row, inventory item added, derived cyberware
   band updated.
4. **Verify UB:** real balance dropped; **verify Discord DM** — the player gets an
   "automatic charge" DM (live-only).
5. Do a **remove** to confirm the reverse path.
6. **Cleanup:** remove the test cyberware; reverse any balance as needed.

### Step 4 — Missions & actor payouts (system: `missions`)

1. Flip `missions_live_mode` ON.
2. As staff, **create** a tiny mission; **apply** as the test player; **assign**;
   **complete**; **pay players** and **pay actors** with €$1 each.
3. **Verify portal:** payout ledger rows; payout batch totals; mission state.
4. **Verify UB:** recipients' real balances rose.
5. **Verify Discord:** the mission **payout post** appears in the configured
   channel, and recipients get a **mission-payout DM** (both live-only).
6. **Pre-mission NPC announcement** (live-only): this is posted by the
   `mission_npc_announce` cron ~1h before a posted mission starts. To smoke-test
   on demand, schedule a mission to start shortly and confirm the "actors needed"
   post lands in the NPC channel. (No kill switch on this cron, but it obeys the
   missions Test/Live gate.)
7. **Cleanup:** cancel/close the test mission; reverse the €$1 payouts.

### Step 5 — Discord scheduled events (system: `missions`)

> Calendar events share the **missions** Test/Live switch. Website-side calendar
> writes always run; only the **Discord-side** scheduled-event mutations are gated.

1. With `missions_live_mode` ON, **create** a calendar event in the portal and
   confirm a matching **Discord scheduled event** is created on the server.
2. **Edit** the event (time/title) in the portal → confirm the Discord event
   updates.
3. **Delete/cancel** it in the portal → confirm the Discord event is removed.
4. *(Optional)* Confirm `discord_event_sync` import direction by checking an event
   created in Discord appears on the portal calendar. (This job's website-side
   import runs even in Test; its Discord mutations are gated by `live`.)
5. **Cleanup:** remove the test event in both places.

### Step 6 — Housing rent + eviction (system: `housing` / `evictions`)

> These are normally **cron** jobs but can be run manually from **Admin → Jobs**
> (`POST /admin/jobs/run`). A manual run **bypasses the kill switch** but still
> obeys the Test/Live gate, so flip the system Live first.

1. Lease a cheap property to the test character in the portal; verify the lease
   and occupancy linkage.
2. Flip `housing_live_mode` ON. Manually run **`monthly_rent`** from Admin → Jobs.
   - **Verify portal:** rent ledger row + `paid_through` advanced.
   - **Verify UB:** real rent debited.
   - **Verify Discord DM:** auto-charge DM delivered.
3. Eviction (**destructive** — deletes the lease row): flip `evictions_live_mode`
   ON, force the lease delinquent past the grace window (set `delinquentSince`
   back via admin tooling, or use a deliberately old test lease), then manually
   run **`eviction_sweep`**.
   - **Verify portal:** lease row deleted, `housing_evicted` activity logged.
   - **Verify Discord:** eviction notice posted to `EVICTION_CHANNEL_ID`.
4. **Cleanup:** the lease is already gone; reverse the test rent debit.

> **Test-mode sanity check (do this BEFORE flipping each cron's system Live):** run
> `monthly_rent` / `cyberware_humanity` / `eviction_sweep` manually while the
> system is still **Test**. The job must report *"Test mode: … made no live
> changes"* and touch nothing (no UB debit, no Discord post, no lease delete).
> That proves the gate before you trust it with real data.

### Step 7 — Role sync (Discord role writes)

1. Run **`role_sync`** manually (no kill switch; it reconciles Discord-derived
   gate flags both directions).
2. **Verify:** a member who lost the Verified-18 role in Discord has portal access
   revoked on the next sweep, and the rules-role is reconciled. Confirm a real
   role read/grant against the live server.

### Step 8 — Turn on automation (only when satisfied)

Once each system has passed its manual smoke test, enable the **cron kill
switches** for the automation you actually want running:

- `housing_autobill_enabled` → monthly rent on the 1st @ 04:00.
- `cyberware_autobill_enabled` → weekly meds, Mondays @ 05:00.
- `mission_autopay_enabled` → mission auto-pay sweep every 15 min.
- `economy_enabled` → UB→website reconcile every 30 min (already set in Step 1 if
  you want economy running).

Leave any you are not ready for **OFF**. The following jobs have **no** kill
switch and run on their schedules regardless — but they differ in what Test/Live
gates:

- `eviction_sweep` — fully gated by the **evictions** Test/Live switch (inert in Test).
- `mission_npc_announce` — its Discord post is gated by the **missions** switch
  (inert in Test). *(Not in the `/admin/jobs/run` allowlist — cannot be triggered
  manually; smoke-test it by scheduling a mission to start soon, per Step 4.6.)*
- `discord_event_sync` and `main_session_backfill` — **partly gated**: their
  **website-side** writes (importing Discord events, creating calendar rows) run
  even in Test; **only the Discord-side mutations** are gated by the live flag.
- `role_sync` — **not gated by Test/Live at all.** Once deployed it performs real
  Discord role grants/revokes every 6h (see the safety-model note above).

> **Mission autopay Test→Live caveat:** missions "paid" while in Test are stamped
> processed and will not pay for real on their own. The autopay live-retry path
> recovers them once the system is Live — confirm a previously-simulated mission
> actually pays out after going Live, rather than assuming it will.

### Step 9 — Final cleanup

- Delete/retire the throwaway test character and any test stock/leases/events.
- Reconcile the test Discord account's UB balance back to its starting value.
- Re-read the audit log (`/admin/audit-log`) and confirm every test action is
  recorded as expected.

---

## Part 3 — Abort / rollback plan

### 3.1 Instant "stop everything" (no redeploy needed)

Because every live effect is gated on `bot_config` flags read per-action, you can
freeze all real external effects **immediately** from Admin without redeploying:

1. **Flip `master_live_mode` OFF.** This alone returns every Test/Live-gated
   system to Test — no UB debits, no Discord posts/DMs, no lease deletes will
   occur, even mid-cron. **Caveat:** this does **not** stop `role_sync` Discord
   role grants/revokes or the `/auth/accept-rules` rules-role grant — those are not
   behind the switchboard. If a role write is the problem, fix it in Discord
   directly and, if needed, temporarily neutralize the trigger (e.g. correct the
   member's roles in Discord; role-sync reconciles toward the portal's gate flags).
2. If you want to keep some systems live but stop one, flip just that system's
   `<sys>_live_mode` OFF.
3. To stop the **automatic schedule** without touching Test/Live, flip the
   relevant **kill switch** OFF (`*_autobill_enabled`, `mission_autopay_enabled`,
   `economy_enabled`). Manual admin runs will still work but stay gated.

> This is the first thing to do if anything looks wrong. It is reversible and takes
> effect on the next action — no deploy, no restart.

### 3.2 Undoing data damage

- **Wallet / UB:** money moves are double-booked (portal `wallet_transactions`
  ledger + UB). To undo, issue an equal-and-opposite transfer/charge of the same
  tiny amount; confirm both the ledger and the real UB balance return to baseline.
  Wallet balances are `int4` (max 2,147,483,647) — never "fix" by writing a huge
  number.
- **Evictions (destructive):** `eviction_sweep` **deletes** the lease row. There
  is no in-app undo — re-create the lease manually if it was evicted in error.
  This is why eviction is tested last and on a deliberately disposable lease.
- **Discord posts/DMs/events:** delete the erroneous post/event in Discord; DMs
  cannot be recalled — note it and move on.

### 3.3 Database rollback

The development database supports checkpoint rollback (see the diagnostics skill).
**Production** is managed separately: do not run destructive SQL against prod. If a
bad schema reached production via Publish, fix the schema in dev and re-Publish to
re-diff — do not hand-edit prod.

### 3.4 Full deployment rollback

If the deploy itself is broken (not just a bad flag):

- Use **`getDeploymentInfo()`** to confirm build health and the production URL.
- Check **deployment logs** (deployment skill) for the real error before changing
  code.
- Republish a known-good build, or roll the repl back to a prior checkpoint and
  re-Publish. Keep `master_live_mode` OFF until the new build passes Part 2 again.

---

## Appendix — Live-only surface inventory

Surfaces that **cannot** be proven by the automated suites (Tasks #206 backend,
#207 e2e) because they require real external writes — each is covered above:

- UB balance changes: wallet transfers, purchases/sales, ripperdoc charges,
  mission/actor payouts, autobilled rent/meds/fees, economy reconcile folds.
- Discord channel posts: mission payout posts, actor-spend posts, NPC "actors
  needed" announcements, eviction notices, sheet/breach approval posts.
- Discord DMs: auto-charge and mission-payout player notifications.
- Discord role writes: first-login rules-role grant, `role_sync` grant/revoke,
  Verified-18 gate reconciliation.
- Discord scheduled events: create / edit / delete mirrored from the calendar, and
  `discord_event_sync` Discord-side mutations.
- Destructive sweep: `eviction_sweep` lease deletion + notice.
