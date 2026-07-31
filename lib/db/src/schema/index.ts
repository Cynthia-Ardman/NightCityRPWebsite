import { sql } from "drizzle-orm";
import {
  pgTable,
  text,
  serial,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
  uuid,
  date,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey(),
    discordId: text("discord_id").notNull(),
    username: text("username").notNull(),
    globalName: text("global_name"),
    avatarUrl: text("avatar_url"),
    roles: text("roles").array().notNull().default([]),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    tokenExpiresAt: timestamp("token_expires_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    rolesSyncedAt: timestamp("roles_synced_at", { withTimezone: true }),
    // True when the member holds the guild's "Verified 18+" role. Computed from
    // raw Discord role ids at login (and by the admin hydrate sweep). Drives the
    // age-verification gate: users without it can only see the VRChat↔Discord
    // linking guidebook page + a link to the help channel.
    verified18: boolean("verified18").notNull().default(false),
    // ---- Onboarding ----
    // Incremented on every Discord OAuth login. Drives the first-run onboarding
    // banner, which shows only while the count is within the first few logins.
    loginCount: integer("login_count").notNull().default(0),
    // Set when the user dismisses the onboarding banner early, so it never
    // re-appears regardless of the login count.
    onboardingBannerDismissed: boolean("onboarding_banner_dismissed")
      .notNull()
      .default(false),
    // Set when the user dismisses the dashboard "set your Discord ping
    // preferences" prompt. Once dismissed the prompt never re-appears; the
    // toggles remain permanently available on the Settings page.
    notificationPromptDismissed: boolean("notification_prompt_dismissed")
      .notNull()
      .default(false),
    // Set once the member has read and accepted the server rules on the first-run
    // rules splash. While false the SPA shows a blocking rules gate; accepting it
    // also grants the "rules read" Discord role. Never re-appears once true.
    rulesAccepted: boolean("rules_accepted").notNull().default(false),
    // Per-user grant for the CyberPsycho (VRChat security agent) control panel.
    // Fixers/admins always have access; this flag lets admins hand the tool to
    // specific non-staff users from the portal without touching Discord roles.
    cyberpsychoAccess: boolean("cyberpsycho_access").notNull().default(false),
    // Account-level UI text-size preference: "default" | "lg" | "xl". Null =
    // never set from any device (client falls back to its localStorage value).
    // Synced so the choice follows the player across browsers/devices; the
    // client still applies its localStorage copy pre-paint to avoid a flash.
    textScale: text("text_scale"),
    // ---- Economy: website-authoritative player wallet (synced to UnbelievaBoat) ----
    // The website's own balance for this player, in eddies. Every website-side
    // money change goes through the sync wrapper which updates this AND UB. UB
    // stays authoritative for external (Discord) changes, which the
    // reconciliation job folds back in. Defaults to 0 until first sync.
    walletBalance: integer("wallet_balance").notNull().default(0),
    // UB `total` at the moment of the last successful sync/reconcile. Used to
    // detect external deltas: any difference between current UB total and this
    // value is a Discord-side change to reconcile. Null = never synced.
    lastSyncedUbBalance: integer("last_synced_ub_balance"),
    lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
    // Outcome of the most recent sync attempt for this user: synced | failed |
    // pending. Surfaced in the admin sync dashboard. Null = never attempted.
    lastSyncStatus: text("last_sync_status"),
    lastSyncError: text("last_sync_error"),
    // ---- Mission availability defaults (Task #244) ----
    // The player's saved weekly availability pattern, used to pre-fill the
    // mission-application availability picker. An array of { weekday: 0-6 (Sun=0),
    // minutes: 0-1410 } half-hour blocks expressed in the player's LOCAL clock,
    // re-projected onto concrete dates each time the picker opens. Null = none saved.
    defaultAvailability: jsonb("default_availability").$type<
      { weekday: number; minutes: number }[]
    >(),
    // IANA timezone the default pattern was captured in (informational; the
    // picker re-projects in the viewer's current local time). Null = none saved.
    availabilityTimezone: text("availability_timezone"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    discordIdx: uniqueIndex("users_discord_id_idx").on(t.discordId),
  }),
);
export type User = typeof users.$inferSelect;

export const characters = pgTable("characters", {
  id: serial("id").primaryKey(),
  // ownerId is nullable to support "unclaimed" characters imported from the
  // legacy bot whose Discord owner has left the server. A fixer/admin can
  // later assign or reassign the ownerId via the admin UI.
  ownerId: text("owner_id").references(() => users.id, { onDelete: "set null" }),
  // True once a user (or admin) has claimed this character. Imported
  // unclaimed sheets land with claimed=false even when ownerId is set
  // (admin-assigned) until the actual user confirms or logs in. Default true
  // for any character created through the normal "create character" flow.
  claimed: boolean("claimed").notNull().default(true),
  // The Discord username on the sheet at import time. Preserved even after
  // ownerId is filled so we can audit who the sheet "originally belongs to".
  legacyDiscordUsername: text("legacy_discord_username"),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  archetype: text("archetype"),
  background: text("background"),
  // Primary portrait (legacy single-image field). New sheets use
  // portraitUrls / statsImageUrls arrays.
  portraitUrl: text("portrait_url"),
  // All sheet portraits, in display order, re-hosted on object storage as
  // /objects/<id> paths (Discord CDN URLs expire on signed-URL refresh).
  portraitUrls: text("portrait_urls").array().notNull().default([]),
  // VRChat / engine performance-panel screenshots, separated from portraits
  // by the AI classifier at import time. Same /objects/ path format.
  statsImageUrls: text("stats_image_urls").array().notNull().default([]),
  // Parsed sheet sections: { preamble: string, sections: { [label]: string } }.
  sheetData: jsonb("sheet_data"),
  // The Discord forum thread this character was imported from. Used as the
  // idempotency key so re-running the importer upserts rather than dupes.
  importedFromThreadId: text("imported_from_thread_id"),
  // Source channel name at import time (e.g. "character-sheets" or
  // "retired-character-sheets"). Used to mark retired imports as archived.
  importedFromChannelName: text("imported_from_channel_name"),
  // Discord forum tags applied to the source thread (resolved to display
  // names at import time, e.g. ["Solo", "Active", "Edgerunner"]). Used for
  // archive filtering. Empty array for non-imported / pre-tagging chars.
  appliedTags: text("applied_tags").array().notNull().default([]),
  // Staff-managed tags added through the Character Archive UI. Kept in a
  // SEPARATE column from appliedTags (which the Discord importer overwrites
  // on every re-sync) so a re-import can never silently wipe a tag a fixer
  // added by hand. The archive UI shows/filters the UNION of the two arrays,
  // so to the user they are one merged "Tags" list.
  manualTags: text("manual_tags").array().notNull().default([]),
  // For NPCs: the Discord IDs of the responsible fixer and the player who
  // runs the NPC. Free-form text (raw Discord snowflake IDs); may be the same
  // person or different, and either may be null. Purely informational —
  // distinct from ownerId (the linked portal account).
  fixerDiscordId: text("fixer_discord_id"),
  playerDiscordId: text("player_discord_id"),
  discordChannelId: text("discord_channel_id"),
  // Player-visible life status. One of: active | dead | missing | loa |
  // retired. Defaults to 'active'; the importer/admin backfill maps
  // archived sheets to 'retired' and character_status.loa to 'loa'.
  // The transient day-to-day flags (attending, openShop, loaReturnsAt)
  // still live on character_status — this column is just the headline.
  lifeStatus: text("life_status").notNull().default("active"),
  approved: boolean("approved").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  // Optional monthly lifestyle tier (Street/Standard/Affluent/Luxury). Debited
  // alongside rent by the monthly_rent cron. Null = no lifestyle billing.
  lifestyleTierId: integer("lifestyle_tier_id"),
  // Optional Trauma Team subscription tier — one of silver | gold | platinum | diamond
  // (or null = no subscription). Billed monthly from bot_config["trauma_team_costs"].
  // Skipped while character is on LOA. Mirrors NightCityBot trauma-team billing.
  traumaTeamTier: text("trauma_team_tier"),
  // Xanadu Gold premium membership flag. Flat monthly fee from
  // bot_config["xanadu_gold_cost"] (default 500). Skipped while on LOA.
  xanaduGold: boolean("xanadu_gold").notNull().default(false),
  // Last ripperdoc checkup. Resets `checkupStreak` to 0. Null means no
  // checkup has ever been recorded (treated the same as "overdue" by the
  // cyberware_humanity cron, but doesn't pre-charge anything until the
  // first cron tick after this row exists).
  lastCheckupAt: timestamp("last_checkup_at", { withTimezone: true }),
  // Number of consecutive weekly cron ticks since the last checkup. The
  // cyberware_humanity cron multiplies the meds cost by this streak so
  // skipping checkups gets exponentially more expensive (matches
  // NightCityBot's missed-checkup multiplier behavior, but linear).
  checkupStreak: integer("checkup_streak").notNull().default(0),
  // Cyberware-risk band assigned by a ripperdoc (or admin) — matches the
  // NightCityBot's medium/high/extreme Discord-role gating. Drives the
  // weekly meds cap in the cyberware_humanity cron:
  //   none    → no meds charge
  //   medium  → cap 2000 eddies/week
  //   high    → cap 5000 eddies/week
  //   extreme → cap 10000 eddies/week
  // Default is 'none' so existing characters aren't auto-billed until a
  // ripperdoc gives them a checkup and stamps a level.
  cyberwareLevel: text("cyberware_level").notNull().default("none"),
  // Explicit "this character has no chrome on purpose" flag. Set by the
  // cyberware importer when the source spreadsheet lists CWP total = 0, and
  // by admins via the character page. Distinct from "chrome data is missing":
  // organic=true means we know there's no chrome; organic=false + 0 inventory
  // rows means we don't know yet. The dashboard MEDS card and audit reports
  // use this to suppress "missing cyberware" warnings.
  isOrganic: boolean("is_organic").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  importedThreadIdx: uniqueIndex("characters_imported_thread_idx").on(t.importedFromThreadId),
}));
export type Character = typeof characters.$inferSelect;

// Free-form change-log entries written by the character owner whenever they
// edit the sheet. Functions like commit messages: a short note describing
// what changed (new chrome installed, retconned background, etc). Displayed
// at the bottom of the character profile in newest-first order.
export const characterUpdates = pgTable("character_updates", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CharacterUpdate = typeof characterUpdates.$inferSelect;

// Per-user cooldown ledger for the dashboard income commands (WORK / SLUT).
// One row per (user, command); `lastUsedAt` is the anchor a server-side 20h
// cooldown is measured from. The composite PK makes the atomic
// reserve-on-conflict upsert in the income routes possible.
export const incomeCommandUses = pgTable(
  "income_command_uses",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    command: text("command").notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.command] }),
  }),
);
export type IncomeCommandUse = typeof incomeCommandUses.$inferSelect;

export const characterStatus = pgTable("character_status", {
  characterId: integer("character_id").primaryKey().references(() => characters.id, { onDelete: "cascade" }),
  loa: boolean("loa").notNull().default(false),
  loaReturnsAt: timestamp("loa_returns_at", { withTimezone: true }),
  attending: boolean("attending").notNull().default(false),
  openShop: boolean("open_shop").notNull().default(false),
  statusMessage: text("status_message"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const inventoryItems = pgTable("inventory_items", {
  id: serial("id").primaryKey(),
  // Stable per-instance identifier that survives transfers between characters.
  // The numeric id is used by every existing route/UI as the primary key, so we
  // keep it; this uuid is the durable handle the chain-of-custody log keys off
  // of. When a stack splits on partial transfer, the new stack gets a fresh
  // uuid (it is a new instance); the source keeps its uuid.
  instanceUuid: uuid("instance_uuid").notNull().default(sql`gen_random_uuid()`).unique(),
  // characterId is nullable so legacy/migrated items can sit under a player's account
  // without being assigned to a specific character. The player picks the character later.
  characterId: integer("character_id").references(() => characters.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  quantity: integer("quantity").notNull().default(1),
  notes: text("notes"),
  // Free-text cyberware required to operate this item, when it is a gun
  // (mirrors catalog_guns.cyberware_req). Null for non-guns / no requirement.
  cyberwareReq: text("cyberware_req"),
  equipped: boolean("equipped").notNull().default(false),
  pricePaid: integer("price_paid"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type InventoryItem = typeof inventoryItems.$inferSelect;

// Per-instance audit log: every meaningful state change for an inventory item
// (creation, transfer, sale, split, adjustment, consumption, destruction) is
// appended here. Keyed by inventoryItems.instanceUuid so the chain survives
// even after the underlying row is deleted (consumed/destroyed).
export const inventoryEvents = pgTable("inventory_events", {
  id: serial("id").primaryKey(),
  instanceUuid: uuid("instance_uuid").notNull(),
  // One of: created | transferred | sold | split | adjusted | consumed | destroyed | history_begins
  kind: text("kind").notNull(),
  // Who performed the action (user id). Null for system actions (importer, cron).
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  fromCharacterId: integer("from_character_id"),
  fromCharacterName: text("from_character_name"),
  toCharacterId: integer("to_character_id"),
  toCharacterName: text("to_character_name"),
  // Snapshot of item name at event time (item may be renamed later).
  itemName: text("item_name").notNull(),
  quantity: integer("quantity"),
  price: integer("price"),
  reason: text("reason"),
  // Free-form structured metadata (split parent uuid, venue id, mission id, etc).
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uuidIdx: index("inv_events_uuid_idx").on(t.instanceUuid),
  createdIdx: index("inv_events_created_idx").on(t.createdAt),
}));
export type InventoryEvent = typeof inventoryEvents.$inferSelect;

export const walletTransactions = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  // Either characterId OR userId must be set. characterId is used for character-scoped
  // transfers; userId-only rows are historical/account-level deltas (e.g. legacy bot
  // balance_history rows that pre-date the character split).
  characterId: integer("character_id").references(() => characters.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  counterpartyCharacterId: integer("counterparty_character_id"),
  counterpartyName: text("counterparty_name"),
  amount: integer("amount").notNull(),
  kind: text("kind").notNull(),
  memo: text("memo"),
  // Coarse display/reporting bucket (rent, cyberware, mission, business,
  // membership, fee, purchase, transfer, other), derived from kind+memo via
  // classifyWalletCategory. Independent of `kind`, which stays load-bearing for
  // billing logic. Backfilled for historical rows; live rows fall back to a
  // derived value in the API if null. See walletCategory.ts.
  category: text("category"),
  // ---- Economy ledger extension ----
  // Where this entry originated. One of: website | ub | reconciliation |
  // mission | store | ripperdoc | commission | admin. Drives reporting and
  // tells reconciliation which rows it created.
  source: text("source").notNull().default("website"),
  // Sync lifecycle for website-originated player changes: pending (reserved,
  // UB not yet confirmed) | synced (UB applied) | failed (UB rejected, balance
  // NOT changed) | reconciled (created by the reconciliation job to mirror a
  // UB-side change). Venue-only rows are 'synced' (no UB leg).
  syncStatus: text("sync_status").notNull().default("synced"),
  // Idempotency key for website-originated changes. Unique so a retry of the
  // same logical change can find the existing row instead of double-applying.
  idempotencyKey: text("idempotency_key"),
  // Optional pointer to the domain entity that caused this change.
  relatedEntityType: text("related_entity_type"),
  relatedEntityId: integer("related_entity_id"),
  // Player website balance immediately before / after this entry (for player
  // rows). Null for legacy/venue rows that don't move a player wallet.
  previousBalance: integer("previous_balance"),
  newBalance: integer("new_balance"),
  // Failure detail when syncStatus = 'failed'.
  errorMessage: text("error_message"),
  // Venue account this entry belongs to (mutually exclusive with each other;
  // a deposit/withdraw writes one player row AND one venue row). Null for
  // pure player transactions.
  storeId: integer("store_id").references(() => stores.id, { onDelete: "cascade" }),
  ripperdocId: integer("ripperdoc_id").references(() => ripperdocs.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  charIdx: index("wt_char_idx").on(t.characterId),
  userIdx: index("wt_user_idx").on(t.userId),
  idemIdx: uniqueIndex("wt_idem_idx").on(t.idempotencyKey),
  storeIdx: index("wt_store_idx").on(t.storeId),
  ripperdocIdx: index("wt_ripperdoc_idx").on(t.ripperdocId),
}));

export const stores = pgTable("stores", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerCharacterId: integer("owner_character_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("mixed"),
  purpose: text("purpose"),
  location: text("location"),
  // Optional link to the business `housing` lease this venue operates out of.
  // Staff associate it from the venue management page (or it's set when an
  // on-map venue request is approved). onDelete: set null so deleting/expiring
  // the lease just unlinks the venue rather than cascading it away.
  housingId: integer("housing_id").references((): AnyPgColumn => housing.id, { onDelete: "set null" }),
  description: text("description"),
  bannerUrl: text("banner_url"),
  // Website-only business account balance (eddies). Never synced to UB —
  // owners move money between this and their personal wallet via deposit/
  // withdraw. Reconciliation never touches this.
  balance: integer("balance").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storeEmployees = pgTable("store_employees", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("clerk"),
  // Per-employee commission percentage (0-100) of each sale they broker. Owner
  // sets it; staff can audit. Snapshotted onto a sale_offer at creation time.
  commissionPct: integer("commission_pct").notNull().default(0),
});

export const storeStock = pgTable("store_stock", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  price: integer("price").notNull().default(0),
  // Per-unit cost the shop paid to acquire this item. Recovered by the shop
  // before commission: employee commission is a % of (price - cost) profit, not
  // the full sale price. Default 0 => entire sale is profit (legacy behavior).
  cost: integer("cost").notNull().default(0),
  quantity: integer("quantity").notNull().default(0),
  notes: text("notes"),
  description: text("description"),
  // Gun power level (e.g. "Power", "Tech", "Smart" / a tier label). Only
  // meaningful for gun stores; staff-managed since gun-store owners can't edit
  // their own stock. Mirrors catalog_guns.power_level.
  powerLevel: text("power_level"),
  // Free-text cyberware required to operate this gun (mirrors
  // catalog_guns.cyberware_req). Only meaningful for gun-store stock.
  cyberwareReq: text("cyberware_req"),
});

export const ripperdocs = pgTable("ripperdocs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerCharacterId: integer("owner_character_id"),
  name: text("name").notNull(),
  purpose: text("purpose"),
  location: text("location"),
  // Optional link to the business `housing` lease this venue operates out of.
  // See stores.housingId.
  housingId: integer("housing_id").references((): AnyPgColumn => housing.id, { onDelete: "set null" }),
  description: text("description"),
  bannerUrl: text("banner_url"),
  // Website-only business account balance (eddies). See stores.balance.
  balance: integer("balance").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ripperdocEmployees = pgTable("ripperdoc_employees", {
  id: serial("id").primaryKey(),
  ripperdocId: integer("ripperdoc_id").notNull().references(() => ripperdocs.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("doc"),
  // See store_employees.commission_pct.
  commissionPct: integer("commission_pct").notNull().default(0),
});

export const ripperdocStock = pgTable("ripperdoc_stock", {
  id: serial("id").primaryKey(),
  ripperdocId: integer("ripperdoc_id").notNull().references(() => ripperdocs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  price: integer("price").notNull().default(0),
  // Per-unit acquisition cost. See storeStock.cost — commission is a % of the
  // (price - cost) profit, so the clinic recovers its cost before paying out.
  cost: integer("cost").notNull().default(0),
  quantity: integer("quantity").notNull().default(0),
  notes: text("notes"),
  description: text("description"),
});

export const fixerNpcs = pgTable("fixer_npcs", {
  id: serial("id").primaryKey(),
  fixerId: text("fixer_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  archetype: text("archetype"),
  district: text("district"),
  description: text("description"),
  portraitUrl: text("portrait_url"),
  contact: text("contact"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const characterSheets = pgTable("character_sheets", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: integer("character_id"),
  name: text("name").notNull(),
  // draft | pending | approved | rejected | changes_requested. Reviewers cast
  // majority votes (review_votes) to approve/reject; "request changes" parks it
  // in changes_requested until the owner resubmits.
  status: text("status").notNull().default("pending"),
  data: jsonb("data").notNull(),
  decisionBy: text("decision_by"),
  decisionNote: text("decision_note"),
  // Admin who used "approve override" to bypass the majority vote (nullable).
  overriddenBy: text("overridden_by").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // Archive lifecycle (see custom_requests). Closing an approved sheet
  // materializes the character; closing a rejected sheet just archives it.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: text("closed_by").references(() => users.id),
  // The resolved status the sheet had at close time (approved | rejected).
  // Preserved because closing overwrites `status` with "closed". Null on
  // legacy closed rows where it wasn't recoverable.
  closedOutcome: text("closed_outcome"),
  discordMessageId: text("discord_message_id"),
  // Discord thread that mirrors this ticket's review discussion in the
  // cs-approver channel. Read-only on the portal; the website never posts to it.
  discordThreadId: text("discord_thread_id"),
  // When the sheet was actually submitted for review (draft/changes_requested ->
  // pending). Distinct from createdAt (when the draft row was first created).
  // Null on drafts never yet submitted; the API falls back to the Discord
  // announce snowflake then createdAt for rows that predate this column.
  submittedAt: timestamp("submitted_at", { withTimezone: true }),
  // Revision stamp for optimistic concurrency on draft edits. Bumped on every
  // PATCH; clients send the value they loaded (baseUpdatedAt) and a mismatch is
  // rejected so a stale tab can't clobber a newer draft saved elsewhere.
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const diceRolls = pgTable("dice_rolls", {
  id: serial("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  characterId: integer("character_id"),
  characterName: text("character_name"),
  expression: text("expression").notNull(),
  label: text("label"),
  rolls: integer("rolls").array().notNull(),
  modifier: integer("modifier").notNull().default(0),
  total: integer("total").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const catalogGuns = pgTable("catalog_guns", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  manufacturer: text("manufacturer"),
  damage: text("damage"),
  magSize: integer("mag_size"),
  price: integer("price").notNull().default(0),
  wholesalePrice: integer("wholesale_price"),
  restriction: text("restriction"),
  status: text("status"),
  powerLevel: text("power_level"),
  weaponType: text("weapon_type"),
  // Optional fire mode (e.g. Semi-Auto / Burst / Full-Auto). Free text so the
  // catalog can capture anything; the UI offers the common presets.
  fireMode: text("fire_mode"),
  notes: text("notes"),
  // Single optional product image, stored as a /api/storage/objects/<id> path.
  imageUrl: text("image_url"),
  // Free-text name of the cyberware a character must have installed to operate
  // this weapon (e.g. "Smartlink"). Null when the gun has no chrome requirement.
  cyberwareReq: text("cyberware_req"),
  // Optional external reference links: the Cyberpunk wiki page and the Discord
  // prefab thread for this weapon.
  wikiUrl: text("wiki_url"),
  prefabThreadUrl: text("prefab_thread_url"),
});

export const catalogCyberware = pgTable("catalog_cyberware", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slot: text("slot").notNull(),
  humanityLoss: integer("humanity_loss").notNull().default(0),
  cwp: text("cwp"),
  price: integer("price").notNull().default(0),
  wholesalePrice: integer("wholesale_price"),
  installCost: integer("install_cost"),
  description: text("description"),
});

export const catalogRent = pgTable("catalog_rent", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  district: text("district"),
  tier: text("tier"),
  monthlyRent: integer("monthly_rent").notNull().default(0),
  description: text("description"),
  // Single optional listing image, stored as a /api/storage/objects/<id> path.
  imageUrl: text("image_url"),
  // "residential" (default) or "business". Residential listings can be leased
  // directly by players; business spaces require a fixer/admin-reviewed request.
  kind: text("kind").notNull().default("residential"),
  // False for listings that exist in the catalog for visibility only and can
  // never be leased or requested (e.g. the Claw-owned Japantown Pharmacy).
  // Enforced in the direct-lease path, the on-map venue request path, and the
  // approval materializer; the portal hides the LEASE/APPLY button.
  leasable: boolean("leasable").notNull().default(true),
});

// Fixer-managed list of districts shown as a dropdown in the property creator.
// Free-form names, unique case-insensitively at the route layer. Properties may
// also use a custom/off-map district not in this list (stored free-form on
// catalog_rent.district), so this is a convenience list, not a constraint.
export const catalogDistricts = pgTable("catalog_districts", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type CatalogDistrict = typeof catalogDistricts.$inferSelect;

// Global, reusable catalog of character tag options. Staff "create" a tag
// option here (top of the Character Archive), then "add" it to individual
// characters via the per-character picker (which writes into characters.
// manualTags). Free-form names, unique case-insensitively at the route layer.
export const characterTagOptions = pgTable("character_tag_options", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Optional Discord role linkage: when set, a character carrying this tag
  // earns the mapped Discord role for its owner. Managed by fixers/admins.
  discordRoleId: text("discord_role_id"),
  // When true, a player adding this tag to their character does NOT get it
  // instantly — the add is diverted into a custom_requests "character_tag"
  // ticket that fixers approve from the Misc Requests queue. Staff edits
  // bypass the gate.
  requiresApproval: boolean("requires_approval").notNull().default(false),
});
export type CharacterTagOption = typeof characterTagOptions.$inferSelect;

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  message: text("message"),
  affectedCount: integer("affected_count"),
});

// Unified audit log written on every state-changing action across the API.
// Lives alongside the older `activity_events` feed (which is a player-facing
// social feed); audit_log is the staff-facing forensic record.
//   category:   broad bucket — auth, wallet, character, inventory,
//               housing, attendance, shop, sheet, admin, mission.
//   action:    machine-readable verb scoped to the category
//               (e.g. "login", "transfer", "update", "decision").
//   actorIp/Ua:capture x-forwarded-for and user-agent at write time so the
//               same row can answer "who did this from where" without a
//               separate session table lookup.
//   targetType:logical row kind ("character", "user", "sheet", ...). Free-
//               form; not a FK because targets live in many tables.
//   targetId:  string form of the target's pk so cross-table queries don't
//               need union casts.
//   before/after: optional JSON snapshots for diff display. Keep small —
//               do NOT dump huge blobs.
export const auditLog = pgTable("audit_log", {
  id: serial("id").primaryKey(),
  category: text("category").notNull(),
  action: text("action").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorIp: text("actor_ip"),
  actorUa: text("actor_ua"),
  targetType: text("target_type"),
  targetId: text("target_id"),
  message: text("message"),
  beforeJson: jsonb("before_json"),
  afterJson: jsonb("after_json"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index("audit_log_created_idx").on(t.createdAt),
  categoryIdx: index("audit_log_category_idx").on(t.category),
  actorIdx: index("audit_log_actor_idx").on(t.actorId),
  targetIdx: index("audit_log_target_idx").on(t.targetType, t.targetId),
}));
export type AuditLogRow = typeof auditLog.$inferSelect;

// Per-user per-day website activity counters for the analytics dashboard.
// `hits` = authenticated API requests (batched in-memory by the auth
// middleware and flushed periodically); `logins` = completed OAuth logins.
// One row per (day, user); counters only ever increment.
export const siteActivityDaily = pgTable("site_activity_daily", {
  day: date("day").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  hits: integer("hits").notNull().default(0),
  logins: integer("logins").notNull().default(0),
}, (t) => ({
  pk: primaryKey({ columns: [t.day, t.userId] }),
  dayIdx: index("site_activity_daily_day_idx").on(t.day),
}));
export type SiteActivityDailyRow = typeof siteActivityDaily.$inferSelect;

export const activityEvents = pgTable("activity_events", {
  id: serial("id").primaryKey(),
  kind: text("kind").notNull(),
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorAvatarUrl: text("actor_avatar_url"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  createdIdx: index("ae_created_idx").on(t.createdAt),
}));

export const housing = pgTable("housing", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  listingId: integer("listing_id"),
  address: text("address").notNull(),
  // District + tier for OFF-MAP leases (listingId null). On-map leases inherit
  // these from the joined catalog_rent listing; these columns let a fixer-decided
  // off-map property (approved via a custom request) carry the same classification
  // the properties page shows. Serializers coalesce(catalog, housing).
  district: text("district"),
  tier: text("tier"),
  monthlyRent: integer("monthly_rent").notNull().default(0),
  // Lease kind: "residential" (default — personal home, skipped while on LOA)
  // or "business" (storefront/venue — billed even on LOA, matching the
  // NightCityBot behavior where business rent never pauses).
  kind: text("kind").notNull().default("residential"),
  paidThrough: timestamp("paid_through", { withTimezone: true }),
  // First moment a rent debit failed for this lease (null = current). Set
  // by monthly_rent when UB rejects the charge; cleared on the next
  // successful debit. The daily eviction_sweep cron deletes leases whose
  // delinquentSince is older than HOUSING_GRACE_DAYS (default 7).
  delinquentSince: timestamp("delinquent_since", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Pending housing rental requests. Players hit POST /housing/requests from
// the catalog browser; admins triage the queue and either approve (which
// materializes a `housing` row and archives the request) or reject (sets
// status=rejected with a reviewer note). One pending request per (character,
// listing) pair is enforced at the route layer, not the DB, so a rejected
// request doesn't block resubmitting.
export const housingRequests = pgTable("housing_requests", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  listingId: integer("listing_id").notNull().references(() => catalogRent.id, { onDelete: "cascade" }),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  kind: text("kind").notNull().default("residential"),
  notes: text("notes"),
  status: text("status").notNull().default("pending"),
  reviewedById: text("reviewed_by_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewerNote: text("reviewer_note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Off-catalog player requests across three types: off-map property (homes /
// businesses not tied to a catalog_rent listing), custom/off-sheet guns, and
// custom cyberware. Players submit free-text (title + description); staff
// triage in the unified Pending Requests page and on approval the system
// auto-applies the request (creates a housing lease or an inventory item).
// `appliedRef` records what was materialized ("housing:<id>" / "inventory:<uuid>")
// so an approval can never be applied twice.
export const customRequests = pgTable("custom_requests", {
  id: serial("id").primaryKey(),
  // One of: property | gun | cyberware | store | ripperdoc | stock_cost |
  // employee_invite | venue_stock | mission_participation (see REQUEST_TYPES in
  // routes/requests.ts and the OpenAPI CustomRequest.type enum).
  type: text("type").notNull(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  // Player-facing label: location/address (property) or item name (gun/cyberware).
  title: text("title").notNull(),
  description: text("description"),
  // Optional reference image the player attaches at submit time. Legacy
  // single-image field, kept in sync as imageUrls[0] for old consumers.
  imageUrl: text("image_url"),
  // All reference images (ordered). Superset of imageUrl; legacy rows may have
  // only imageUrl set, so readers should fall back to [imageUrl].
  imageUrls: jsonb("image_urls").$type<string[]>(),
  // Optional type-specific payload captured at submit time.
  details: jsonb("details"),
  // On-map venue requests (store/ripperdoc) may reserve a real business
  // building from the rent catalog. While the request is live (pending or
  // approved-but-not-yet-closed) this holds the chosen catalog_rent id, which
  // makes the building unavailable to everyone else (catalog occupancy, the
  // on-map dropdown, and the housing self-lease / request flows all count it as
  // occupied). On close a business lease is committed for the chosen building;
  // on reject/cancel the row leaves the live set and the reservation is freed.
  reservedListingId: integer("reserved_listing_id").references(() => catalogRent.id, { onDelete: "set null" }),
  // pending | approved | rejected | changes_requested | cancelled | closed.
  // Reviewers cast majority votes (review_votes) to approve/reject; legacy
  // changes_requested rows resubmit; cancelled/closed are terminal/archive
  // states set by the requester or the review lifecycle.
  status: text("status").notNull().default("pending"),
  reviewedById: text("reviewed_by_id").references(() => users.id),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  reviewerNote: text("reviewer_note"),
  // Admin who used "approve override" to bypass the majority vote (nullable).
  overriddenBy: text("overridden_by").references(() => users.id),
  // Idempotency marker for what was materialized on approval.
  appliedRef: text("applied_ref"),
  // Reviewer-entered mechanical parameters captured at approval time and applied
  // at CLOSE time. Under the deferred-effects lifecycle, a majority approve /
  // override only stages the decision; the effect (and any reviewer-tuned values
  // such as cyberware CWP) is committed when a fixer closes the ticket.
  decisionParams: jsonb("decision_params"),
  // Archive lifecycle. A reviewer "closes" a resolved ticket: closing an approved
  // ticket commits its effect (once — guarded by appliedRef), closing a
  // rejected/cancelled ticket just archives it. closedBy = who closed it.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: text("closed_by").references(() => users.id),
  // The resolved status the ticket had at close time (approved | rejected |
  // cancelled). Closing overwrites `status` with "closed", which used to lose
  // the outcome — this preserves it so the player can still see what happened.
  // Null on legacy closed rows where the outcome wasn't recoverable.
  closedOutcome: text("closed_outcome"),
  // Discord message posted to the cs-approver channel at submit time, and the
  // thread started from it. Read-only mirror on the portal; never written to
  // by the website. customRequests historically did not post to CS — these are
  // populated by the new submit wiring + backfill.
  discordMessageId: text("discord_message_id"),
  discordThreadId: text("discord_thread_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("custom_requests_status_idx").on(t.status),
  requesterIdx: index("custom_requests_requester_idx").on(t.requestedById),
  // At most ONE live reservation per building. Partial-unique over the live
  // statuses so two simultaneous on-map submits can't both reserve the same
  // catalog building (the loser's insert hits this constraint). Released
  // automatically once the request leaves the live set (closed/rejected/
  // cancelled), letting the building be reserved again.
  reservedListingLiveIdx: uniqueIndex("custom_requests_reserved_listing_live_idx")
    .on(t.reservedListingId)
    .where(sql`reserved_listing_id IS NOT NULL AND status IN ('pending', 'approved')`),
  // At most ONE live character_tag request per character+tag. The tag PATCH's
  // read-then-insert dedupe is racy under concurrent submits; this partial
  // unique index makes the loser's insert conflict (handled with
  // onConflictDoNothing). No space-containing literals (deploy migration trap).
  characterTagLiveIdx: uniqueIndex("custom_requests_character_tag_live_idx")
    .on(t.characterId, sql`lower(details ->> 'tag')`)
    .where(sql`type = 'character_tag' AND status IN ('pending', 'changes_requested')`),
}));
export type CustomRequest = typeof customRequests.$inferSelect;

// Buyer-approval sale offers. A store/ripperdoc owner or employee creates an
// offer for a buyer character; the buyer must approve before any money/stock
// moves. Lifecycle: pending | approved | denied | expired. Approve runs the
// atomic buyer-debit -> store-credit -> commission -> stock-decrement ->
// inventory-add flow (see lib/saleOffers.ts). Deny/expiry move nothing.
// Item/price/commission are snapshotted at creation so later stock or
// commission edits never change a pending offer's terms.
export const saleOffers = pgTable("sale_offers", {
  id: serial("id").primaryKey(),
  // "store" | "ripperdoc" — exactly one of storeId/ripperdocId is set.
  kind: text("kind").notNull(),
  // What the offer does on approval:
  //   sale    — drop the stock item into the buyer's inventory (default; the
  //             only thing stores ever do).
  //   install — ripperdoc only: install the stock item as chrome ON the buyer
  //             character (stamps "CWP n ·" notes so meds/band stay accurate).
  //   remove  — ripperdoc only: un-install an existing chrome item from the
  //             buyer character (references removedItemId, no stock leg).
  //   give    — transfer the stock item to the buyer for free (totalPrice 0).
  offerType: text("offer_type").notNull().default("sale"),
  storeId: integer("store_id").references(() => stores.id, { onDelete: "cascade" }),
  ripperdocId: integer("ripperdoc_id").references(() => ripperdocs.id, { onDelete: "cascade" }),
  // The stock row being sold. Kept for decrement; nullable in case the stock
  // row is deleted before approval (then approve fails on the guarded read).
  // Null for `remove` offers (nothing leaves stock).
  stockId: integer("stock_id"),
  // Cyberware points this offer adds (install) or removes (remove). Used for
  // PC capacity validation and for stamping the installed item's notes so the
  // meds cron keeps deriving the right band. Null for non-cyberware offers.
  cwp: integer("cwp"),
  // For `remove` offers: the inventory_items row being un-installed from the
  // buyer character. Null for every other offer type.
  removedItemId: integer("removed_item_id"),
  // For `remove` offers: where the un-installed chrome ends up.
  //   "patient" (or null, the legacy default) — stays in the patient's
  //   inventory under the "cyberware (removed)" category.
  //   "clinic" — the item leaves the patient entirely and lands in the
  //   clinic's ripperdoc_stock (the ripperdoc keeps the part).
  removeDestination: text("remove_destination"),
  // For `install_owned` offers: the existing (uninstalled) inventory_items
  // cyberware row the ripperdoc will install onto the buyer character. Unlike
  // `install`, there is no stock leg — the player already owns the piece. Null
  // for every other offer type.
  installItemId: integer("install_item_id"),
  // Snapshot of the item at offer time.
  itemName: text("item_name").notNull(),
  itemCategory: text("item_category"),
  unitPrice: integer("unit_price").notNull(),
  quantity: integer("quantity").notNull().default(1),
  totalPrice: integer("total_price").notNull(),
  // Snapshot of the shop's total acquisition cost for this offer (unit cost ×
  // quantity), captured at offer time so commission stays fixed even if stock
  // cost changes later. Null for service-fee offers (remove/install_owned/
  // stock_add) which have no cost basis => commission falls back to full price.
  costBasis: integer("cost_basis"),
  // Buyer (must be a claimed character so we can debit a wallet).
  buyerCharacterId: integer("buyer_character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  buyerUserId: text("buyer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Seller: the acting character + the employee row (null when the owner sells
  // directly — owners earn via the store account, not commission).
  sellerCharacterId: integer("seller_character_id"),
  sellerEmployeeId: integer("seller_employee_id"),
  commissionPct: integer("commission_pct").notNull().default(0),
  // Set once commission is paid out (idempotency guard for the store-side leg).
  commissionAmount: integer("commission_amount"),
  commissionSettledAt: timestamp("commission_settled_at", { withTimezone: true }),
  // Who created the offer (for audit/display).
  createdById: text("created_by_id").notNull().references(() => users.id),
  memo: text("memo"),
  status: text("status").notNull().default("pending"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("sale_offers_status_idx").on(t.status),
  buyerIdx: index("sale_offers_buyer_idx").on(t.buyerUserId),
  storeIdx: index("sale_offers_store_idx").on(t.storeId),
  ripperdocIdx: index("sale_offers_ripperdoc_idx").on(t.ripperdocId),
}));
export type SaleOffer = typeof saleOffers.$inferSelect;

export const traumaTeamCalls = pgTable("trauma_team_calls", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  tier: text("tier").notNull(),
  reason: text("reason"),
  costEddies: integer("cost_eddies").notNull().default(0),
  outcome: text("outcome"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const missionLog = pgTable("mission_log", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").references(() => characters.id, { onDelete: "cascade" }),
  fixerId: text("fixer_id").references(() => users.id, { onDelete: "set null" }),
  title: text("title").notNull(),
  summary: text("summary"),
  payoutEddies: integer("payout_eddies").notNull().default(0),
  status: text("status").notNull().default("pending"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ---------------------------------------------------------------------------
// First-class Missions (Task #57 overhaul). Distinct from the legacy
// `mission_log` rows (kept read-only for history). A mission is a scheduled
// event with a tier, player pay, location, slots, a Discord scheduled-event
// link, and a 6-status lifecycle:
//   open | pending | completed | completed_players_paid | completed_paid | cancelled
// Times are stored as timestamptz (UTC); the UI converts to viewer-local on
// display and creator-local on input.
// ---------------------------------------------------------------------------
export const missions = pgTable("missions", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // 1=Street Work, 2=Contract Work, 3=High Risk Operation, 4=Extreme.
  tier: integer("tier").notNull().default(1),
  // Per-player mission pay (auto-paid after the mission window).
  playerPay: integer("player_pay").notNull().default(0),
  // Per-NPC pay snapshotted onto a sign-up when a fixer confirms attendance.
  npcPayAmount: integer("npc_pay_amount").notNull().default(0),
  location: text("location"),
  description: text("description"),
  // Optional custom image; null falls back to a default image at render time.
  imageUrl: text("image_url"),
  status: text("status").notNull().default("open"),
  // Staff approval workflow state, tracked SEPARATELY from runtime `status`:
  //   draft | proposal | approved | posted
  // Only `posted` missions are visible to regular players. A mission can be
  // posted + open at the same time. New missions default to draft; existing
  // missions are backfilled to posted (they were already live).
  workflowState: text("workflow_state").notNull().default("draft"),
  // Who can SEE the mission once posted: 'public' (everyone, the default) or
  // 'private' (only staff fixers/admins, the authoring fixer, and players a
  // fixer has put on the roster). Private missions are hidden from the board,
  // calendar, search, and ALL Discord surfaces (no scheduled event, no forum
  // thread, no sign-up/NPC announcements).
  visibility: text("visibility").notNull().default("public"),
  fixerId: text("fixer_id").references(() => users.id, { onDelete: "set null" }),
  // Mission start (UTC). Null while the fixer is still drafting/selecting.
  startAt: timestamp("start_at", { withTimezone: true }),
  // Optional earlier gather time for NPC actors (UTC). When set, NPC-facing
  // surfaces (homepage banner for signed-up NPCs, Discord "Actors Needed"
  // event/announcement) use this instead of the player start time.
  npcStartAt: timestamp("npc_start_at", { withTimezone: true }),
  durationMinutes: integer("duration_minutes").notNull().default(120),
  // Number of attendee/player slots.
  slots: integer("slots").notNull().default(0),
  // --- Task #62 mission fields ---
  // Staff-only VRChat/world join link (hidden from player-facing views).
  worldLink: text("world_link"),
  // Required job type: combat | non_combat | mixed (player-facing).
  jobType: text("job_type"),
  // Free-text requested skills (player-facing).
  requestedSkills: text("requested_skills"),
  // Optional in-fiction client (player-facing).
  client: text("client"),
  // Player-facing notes shown on the mission brief.
  notesForPlayers: text("notes_for_players"),
  // Fixer-only briefing text. Shown ONLY inside the Fixer tab on the mission
  // detail page (full fixers/admins on any mission; trial fixers on their own
  // approved/posted missions). Stripped from the API response for any viewer
  // who cannot manage the mission, so it never reaches players.
  fixerNotes: text("fixer_notes"),
  // Max player-characters that can be assigned (0 = unlimited). Distinct from
  // `slots` which is the legacy attendee count.
  maxPlayers: integer("max_players").notNull().default(0),
  // Linked Discord scheduled-event id (null if sync never succeeded / test mode).
  discordEventId: text("discord_event_id"),
  // Last Discord sync failure surfaced to staff (cleared on success).
  discordSyncError: text("discord_sync_error"),
  // Discord discussion thread for this mission, mirrored read-only into the
  // portal (separate from the scheduled-event integration above). discordMessageId
  // is the channel post the thread hangs off; discordThreadId == that message id
  // once a thread is started. Persisted only when the write succeeds so a later
  // backfill can recover from the stored message id. Null in dev/test (writes
  // suppressed) or for missions created before this feature.
  discordThreadId: text("discord_thread_id"),
  discordMessageId: text("discord_message_id"),
  // Set once the mission-thread backfill has posted the consolidated current-state
  // snapshot (roster + pending applicants + NPC sign-ups) into the thread.
  // Idempotency + retryability guard: the backfill targets posted, open missions
  // whose thread exists but this is still null, so a snapshot post that Discord
  // rejected (postToChannel returned null) is retried on the next run instead of
  // being lost. Null for missions created before the feature or whose snapshot has
  // not been seeded yet.
  discordThreadSnapshotAt: timestamp("discord_thread_snapshot_at", { withTimezone: true }),
  // Set once the auto-pay cron has processed this mission (idempotency guard).
  autoPayProcessedAt: timestamp("auto_pay_processed_at", { withTimezone: true }),
  // Set once the pre-mission NPC announcement was posted (idempotency guard).
  // Cleared on reschedule so the announcement re-fires for the new time.
  npcAnnouncedAt: timestamp("npc_announced_at", { withTimezone: true }),
  // Manual completion lock (distinct from the auto-managed `status` enum). When
  // set, the mission is read-only for actor payments. Set by the owning fixer,
  // an admin, or an archivist; cleared (reopened) only by an admin/archivist.
  completedAt: timestamp("completed_at", { withTimezone: true }),
  completedBy: text("completed_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  statusIdx: index("missions_status_idx").on(t.status),
  workflowStateIdx: index("missions_workflow_state_idx").on(t.workflowState),
  fixerIdx: index("missions_fixer_idx").on(t.fixerId),
  startIdx: index("missions_start_idx").on(t.startAt),
  // At most one mission per Discord thread (importer + thread-mirror
  // idempotency enforced at the DB level; NULL rows are unconstrained).
  discordThreadIdx: uniqueIndex("missions_discord_thread_idx")
    .on(t.discordThreadId)
    .where(sql`discord_thread_id IS NOT NULL`),
}));
export type Mission = typeof missions.$inferSelect;

// One row per assigned player on a mission (player + their selected
// character + per-player payment/attendance state). UNIQUE (mission, user)
// guarantees a player is assigned (and paid) at most once per mission.
export const missionAssignments = pgTable("mission_assignments", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: integer("character_id").references(() => characters.id, { onDelete: "set null" }),
  // When attendance was credited by the post-mission cron (null = not yet).
  attendanceCreditedAt: timestamp("attendance_credited_at", { withTimezone: true }),
  // Player-pay state: unpaid | paid | failed | simulated.
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  payAmount: integer("pay_amount"),
  paymentError: text("payment_error"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneAssignmentPerUserIdx: uniqueIndex("mission_assignments_mission_user_idx").on(t.missionId, t.userId),
  missionIdx: index("mission_assignments_mission_idx").on(t.missionId),
  userIdx: index("mission_assignments_user_idx").on(t.userId),
}));
export type MissionAssignment = typeof missionAssignments.$inferSelect;

// Actor payment / participation history (manual "Pay Actors" or future
// automation). Supports reporting ("who acted for me / how many times").
// A partial unique index prevents a second SUCCESSFUL pay for the same
// (mission, actor) pair while still allowing failed/simulated retries.
export const missionActorPayments = pgTable("mission_actor_payments", {
  id: serial("id").primaryKey(),
  // Nullable: actor payments can be tied to a mission OR to a free-form
  // non-mission event (regular session, open social lobby). When missionId is
  // null the event label lives in missionName, the date in missionDate, and the
  // preset category in eventType.
  missionId: integer("mission_id").references(() => missions.id, { onDelete: "cascade" }),
  // Optional link to a non-mission portal event. When set, actor payouts are
  // deduped per (eventId, userId) so the same NPC can't be paid twice for one
  // event (a no-show left unchecked can still be paid later).
  eventId: integer("event_id").references(() => events.id, { onDelete: "set null" }),
  missionName: text("mission_name"),
  // Preset category for non-mission payouts: 'session' | 'social_lobby' |
  // 'other'. Null for mission-tied actor payments.
  eventType: text("event_type"),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  userName: text("user_name"),
  characterId: integer("character_id"),
  characterName: text("character_name"),
  fixerId: text("fixer_id"),
  fixerName: text("fixer_name"),
  missionDate: timestamp("mission_date", { withTimezone: true }),
  // For payouts tied to a RECURRING portal event: the concrete occurrence
  // (startAt instant) the payout covers. Null for non-recurring events,
  // mission payouts, and all legacy rows. Lets the same NPC be paid once per
  // occurrence instead of once per event series.
  occurrenceStartAt: timestamp("occurrence_start_at", { withTimezone: true }),
  amount: integer("amount").notNull().default(0),
  // paid | failed | simulated.
  paymentStatus: text("payment_status").notNull().default("paid"),
  // manual | auto.
  source: text("source").notNull().default("manual"),
  paymentError: text("payment_error"),
  attendanceCreditedAt: timestamp("attendance_credited_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  onePaidPerActorIdx: uniqueIndex("mission_actor_paid_unique_idx")
    .on(t.missionId, t.userId)
    .where(sql`payment_status = 'paid'`),
  // Pay-once guard for non-mission EVENT payouts. Split into two plain partial
  // indexes (no coalesce() sentinel — see event_npc_signups indexes for why):
  // non-recurring events / legacy rows dedupe per (eventId, userId); recurring
  // events dedupe per (eventId, userId, occurrence) so the same NPC can be
  // paid again for a later occurrence of the same weekly social.
  onePaidPerEventActorIdx: uniqueIndex("mission_actor_event_paid_unique_idx")
    .on(t.eventId, t.userId)
    .where(sql`payment_status = 'paid' and event_id is not null and occurrence_start_at is null`),
  onePaidPerEventActorOccIdx: uniqueIndex("mission_actor_event_occ_paid_unique_idx")
    .on(t.eventId, t.userId, t.occurrenceStartAt)
    .where(sql`payment_status = 'paid' and event_id is not null and occurrence_start_at is not null`),
  missionIdx: index("mission_actor_payments_mission_idx").on(t.missionId),
  userIdx: index("mission_actor_payments_user_idx").on(t.userId),
  fixerIdx: index("mission_actor_payments_fixer_idx").on(t.fixerId),
}));
export type MissionActorPayment = typeof missionActorPayments.$inferSelect;

// Player applications to open missions (Task #62). A player applies with ONE
// of their own characters plus an optional comment; the mission's fixer reviews
// and accepts applicants (which assigns them). A partial unique index keeps at
// most one ACTIVE application per (mission, character); re-applying after a
// withdraw/reject upserts the existing row back to pending.
export const missionApplications = pgTable("mission_applications", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  comment: text("comment"),
  // When2Meet-style availability (Task #244): an array of UTC ISO instant
  // strings, one per selected 30-minute block, stored as ABSOLUTE instants so
  // a fixer can overlap applicants who picked in different time zones. Null /
  // empty = the applicant didn't supply availability.
  availability: jsonb("availability").$type<string[]>(),
  // pending | accepted | withdrawn | rejected.
  status: text("status").notNull().default("pending"),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  oneActivePerCharacterIdx: uniqueIndex("mission_applications_mission_character_idx").on(t.missionId, t.characterId),
  missionIdx: index("mission_applications_mission_idx").on(t.missionId),
  userIdx: index("mission_applications_user_idx").on(t.userId),
}));
export type MissionApplication = typeof missionApplications.$inferSelect;

// Player NPC sign-ups (Task #185). A player signs up to act as an NPC on a
// not-yet-completed mission; the mission's fixer later confirms whether they
// actually attended (and pays them) or marks a no-show. A partial unique index
// keeps at most one ACTIVE ('signed_up') sign-up per (mission, user); resolving
// a sign-up to attended/no_show frees the slot so a re-signup is possible.
export const missionNpcSignups = pgTable("mission_npc_signups", {
  id: serial("id").primaryKey(),
  missionId: integer("mission_id").notNull().references(() => missions.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: integer("character_id").references(() => characters.id, { onDelete: "set null" }),
  // signed_up | attended | no_show
  state: text("state").notNull().default("signed_up"),
  // Snapshotted from missions.npcPayAmount at the moment a fixer confirms.
  payAmount: integer("pay_amount"),
  // unpaid | processing | paid | failed | simulated
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentError: text("payment_error"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  oneActivePerUserIdx: uniqueIndex("mission_npc_signups_active_idx")
    .on(t.missionId, t.userId)
    .where(sql`state = 'signed_up'`),
  missionIdx: index("mission_npc_signups_mission_idx").on(t.missionId),
  userIdx: index("mission_npc_signups_user_idx").on(t.userId),
}));
export type MissionNpcSignup = typeof missionNpcSignups.$inferSelect;

// Normalised subset of Discord's recurrence_rule, stored on an event row and
// expanded client-side onto the calendar. frequency: 0=yearly, 1=monthly,
// 2=weekly, 3=daily. byWeekday uses Discord's 0=Mon..6=Sun. An open-ended
// series leaves both count and until null.
export interface EventRecurrenceRule {
  frequency: number;
  interval: number;
  byWeekday: number[] | null;
  count: number | null;
  until: string | null;
}

// Non-mission events (regular sessions, social lobbies, etc.). Distinct from
// `missions`: events carry no money/payment lifecycle — they're a calendar
// item plus an optional "actors needed" call. A website event optionally owns
// a linked Discord scheduled-event (mirrors missions.discordEventId), kept in
// sync by the events service (gated by the shared missions Test/Live switch).
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Preset category: 'session' | 'social' | 'other'. Drives calendar styling.
  eventType: text("event_type").notNull().default("social"),
  location: text("location"),
  description: text("description"),
  // Optional banner image; null falls back to a default at render time.
  imageUrl: text("image_url"),
  // Event window (UTC). Both required — Discord scheduled events need a start
  // AND end time.
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  endAt: timestamp("end_at", { withTimezone: true }).notNull(),
  // scheduled | cancelled
  status: text("status").notNull().default("scheduled"),
  // Optional NPC call: when needsNpcs, players can apply to act as an NPC and
  // npcBlurb describes what's needed.
  needsNpcs: boolean("needs_npcs").notNull().default(false),
  npcBlurb: text("npc_blurb"),
  createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
  // Linked Discord scheduled-event id (null if sync never succeeded / test mode).
  discordEventId: text("discord_event_id"),
  // Last Discord sync failure surfaced to staff (cleared on success).
  discordSyncError: text("discord_sync_error"),
  // Hash of the last reconciled Discord content (title/description/location/
  // start/end). The reconcile cron compares each side's current hash to this to
  // tell which side changed since the last sync ("most recent edit wins")
  // without a Discord-side modified timestamp.
  discordSyncedHash: text("discord_synced_hash"),
  // When this row was last reconciled with its Discord scheduled event.
  discordSyncedAt: timestamp("discord_synced_at", { withTimezone: true }),
  // Normalised Discord recurrence rule (null = single occurrence). Mirrors the
  // subset of Discord's recurrence_rule we expand client-side onto the calendar:
  // frequency (0=Y,1=M,2=W,3=D), interval, optional weekday set (0=Mon..6=Sun),
  // and an optional end via count or until.
  recurrenceRule: jsonb("recurrence_rule").$type<EventRecurrenceRule>(),
  // ISO start instants of occurrences REMOVED from this recurring series —
  // written when staff edit "just this occurrence" (the occurrence splits into
  // its own standalone event row and the series skips this date). Client-side
  // expansion filters these out.
  excludedOccurrences: jsonb("excluded_occurrences").$type<string[]>().notNull().default([]),
  // VRChat group-calendar mirror (third downstream target beside Discord, gated
  // by the `vrchat_calendar_sync_enabled` kill-switch + deployment write-gate).
  // Only Main Sessions + social events are mirrored; missions never are.
  // Linked VRChat calendar event id (cal_…); null if never synced / torn down.
  vrchatCalendarId: text("vrchat_calendar_id"),
  // Last VRChat sync failure surfaced to staff (cleared on success).
  vrchatSyncError: text("vrchat_sync_error"),
  // Hash of the last content pushed to VRChat (title/description/start/end);
  // lets the sync skip a no-op write when nothing changed.
  vrchatSyncedHash: text("vrchat_synced_hash"),
  // When this row was last reconciled with its VRChat calendar event.
  vrchatSyncedAt: timestamp("vrchat_synced_at", { withTimezone: true }),
  // Ticket revenue destination: 'runner' credits ticketRunnerUserId (defaulting
  // to the creator at purchase time when unset) | 'sink' burns to Night City Bot.
  ticketPayoutMode: text("ticket_payout_mode").notNull().default("runner"),
  // The user credited with ticket revenue when ticketPayoutMode = 'runner'.
  // Null falls back to createdById at purchase time.
  ticketRunnerUserId: text("ticket_runner_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  startIdx: index("events_start_idx").on(t.startAt),
  statusIdx: index("events_status_idx").on(t.status),
  createdByIdx: index("events_created_by_idx").on(t.createdById),
  // At most one event row per linked Discord scheduled event. Partial (only
  // non-null ids) so the many never-synced rows don't collide, and it lets the
  // reconcile import use onConflictDoNothing to stay idempotent under
  // concurrent cron/manual runs or a race with the synchronous create path.
  discordEventIdUnq: uniqueIndex("events_discord_event_id_unq")
    .on(t.discordEventId)
    .where(sql`${t.discordEventId} is not null`),
}));
export type Event = typeof events.$inferSelect;

// Player sign-ups to act as an NPC on an event that has needsNpcs set. A
// partial unique index keeps at most one ACTIVE ('signed_up') sign-up per
// (event, user); withdrawing frees the slot so a re-signup is possible.
export const eventNpcSignups = pgTable("event_npc_signups", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  characterId: integer("character_id").references(() => characters.id, { onDelete: "set null" }),
  note: text("note"),
  // For recurring events, the concrete occurrence this signup targets (the
  // occurrence's startAt instant). Null = the event's single/base occurrence
  // (also all legacy rows from before per-occurrence scoping — clients treat
  // null as "the event's current startAt occurrence").
  occurrenceStartAt: timestamp("occurrence_start_at", { withTimezone: true }),
  // signed_up | withdrawn | attended | no_show. An organizer later confirms
  // whether the volunteer actually attended (and pays them) or marks a no-show,
  // mirroring the mission NPC lifecycle (missionNpcSignups).
  state: text("state").notNull().default("signed_up"),
  // Eddies paid for attending; snapshotted from the organizer's per-person fee
  // at confirm time (events have no fixed NPC pay amount, unlike missions).
  payAmount: integer("pay_amount"),
  // unpaid | processing | paid | failed | simulated
  paymentStatus: text("payment_status").notNull().default("unpaid"),
  paymentError: text("payment_error"),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  // One active signup per (event, user, occurrence). Split into two plain
  // partial indexes instead of a coalesce() expression index: Postgres
  // normalizes the 'epoch' sentinel into a space-containing timestamp literal
  // that the deploy-time migration differ mangles into invalid DDL
  // ("::timesta timestamptz_ops" syntax error), blocking production publishes.
  oneActivePerUserOccIdx: uniqueIndex("event_npc_signups_active_occ_idx")
    .on(t.eventId, t.userId, t.occurrenceStartAt)
    .where(sql`state = 'signed_up' AND occurrence_start_at IS NOT NULL`),
  oneActivePerUserNullOccIdx: uniqueIndex("event_npc_signups_active_null_occ_idx")
    .on(t.eventId, t.userId)
    .where(sql`state = 'signed_up' AND occurrence_start_at IS NULL`),
  eventIdx: index("event_npc_signups_event_idx").on(t.eventId),
  userIdx: index("event_npc_signups_user_idx").on(t.userId),
}));
export type EventNpcSignup = typeof eventNpcSignups.$inferSelect;

// ---------------------------------------------------------------------------
// Event tickets: fixers define ticket types on an event; players buy them with
// UB money; designated check-in staff mark holders attended at the door.
// ---------------------------------------------------------------------------

// A purchasable ticket tier on an event (e.g. VIP / General). Price is
// snapshotted onto each sold ticket, so editing a type never rewrites history.
export const eventTicketTypes = pgTable("event_ticket_types", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  // Price in eddies. 0 = free ticket (still recorded, no wallet movement).
  price: integer("price").notNull().default(0),
  // Total sellable. 0 = unlimited.
  quantity: integer("quantity").notNull().default(0),
  sortOrder: integer("sort_order").notNull().default(0),
  // Soft-delete: archived types stop selling but keep sold tickets labelled.
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  eventIdx: index("event_ticket_types_event_idx").on(t.eventId),
}));
export type EventTicketType = typeof eventTicketTypes.$inferSelect;

// A sold ticket. ACCOUNT-level (buyerUserId, no characterId — per product
// decision). Ticket views always JOIN the live event row for time/place; only
// the price is snapshotted (refunds return exactly what was paid).
// status lifecycle: pending (reserved, buyer debit in flight) -> purchased ->
// refunded. Capacity counts pending + purchased so a mid-purchase reservation
// can't be oversold; a failed debit deletes the pending row.
export const eventTickets = pgTable("event_tickets", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id").notNull().references(() => eventTicketTypes.id, { onDelete: "cascade" }),
  buyerUserId: text("buyer_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Eddies actually paid (price snapshot at purchase time).
  pricePaid: integer("price_paid").notNull(),
  // pending | purchased | refunded
  status: text("status").notNull().default("pending"),
  // Runner-credit leg outcome: none (sink/free/test) | paid | failed.
  // 'failed' means the buyer was charged but the runner credit bounced —
  // retryable by a manager without re-charging the buyer.
  payoutStatus: text("payout_status").notNull().default("none"),
  payoutError: text("payout_error"),
  // Check-in (idempotent + undoable; attended tickets can't be refunded).
  attendedAt: timestamp("attended_at", { withTimezone: true }),
  attendedById: text("attended_by_id").references(() => users.id, { onDelete: "set null" }),
  // Refund audit trail (buyer- or manager-initiated, or bulk on cancel).
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  refundedById: text("refunded_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (t) => ({
  eventIdx: index("event_tickets_event_idx").on(t.eventId),
  typeIdx: index("event_tickets_type_idx").on(t.ticketTypeId),
  buyerIdx: index("event_tickets_buyer_idx").on(t.buyerUserId),
}));
export type EventTicket = typeof eventTickets.$inferSelect;

// Per-event door staff: fixer-picked portal users (need not be fixers) allowed
// to view the attendee list and toggle ATTENDED for this one event.
export const eventCheckinStaff = pgTable("event_checkin_staff", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  addedById: text("added_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneStaffPerEvent: uniqueIndex("event_checkin_staff_unq").on(t.eventId, t.userId),
  userIdx: index("event_checkin_staff_user_idx").on(t.userId),
}));
export type EventCheckinStaff = typeof eventCheckinStaff.$inferSelect;

export const wholesalerItems = pgTable("wholesaler_items", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  category: text("category"),
  // Tier this item belongs to: "store" (sold from store_stock) or
  // "ripperdoc" (sold from ripperdoc_stock). Determines which kind of
  // venue can restock it.
  tier: text("tier").notNull().default("store"),
  wholesalePrice: integer("wholesale_price").notNull().default(0),
  // Optional MSRP shown to fixers as guidance for retail markup. Does not
  // affect store_stock.price (set by the venue at restock time).
  suggestedRetailPrice: integer("suggested_retail_price"),
  // Optional total units the wholesaler will ever supply. Null = unlimited.
  // Bump the cap (or null it) to "reset the period" — orders are summed
  // against this cap.
  cap: integer("cap"),
  notes: text("notes"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const wholesalerOrders = pgTable("wholesaler_orders", {
  id: serial("id").primaryKey(),
  wholesalerItemId: integer("wholesaler_item_id").notNull().references(() => wholesalerItems.id, { onDelete: "restrict" }),
  fixerId: text("fixer_id").notNull().references(() => users.id, { onDelete: "set null" }),
  // Where the units landed. Exactly one of storeId / ripperdocId is set.
  storeId: integer("store_id").references(() => stores.id, { onDelete: "set null" }),
  ripperdocId: integer("ripperdoc_id").references(() => ripperdocs.id, { onDelete: "set null" }),
  quantity: integer("quantity").notNull(),
  unitWholesalePrice: integer("unit_wholesale_price").notNull(),
  totalCost: integer("total_cost").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  itemIdx: index("wo_item_idx").on(t.wholesalerItemId),
}));

export const botConfig = pgTable("bot_config", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Discord <-> VRChat username links, scraped from the #vrchat-username channel.
// Each Discord message there is posted BY the player whose VRChat profile it
// links to, so the message author is the Discord identity and the message body
// (plus the unfurled embed) carries the VRChat profile. Keyed by Discord user
// id so a re-scan upserts the latest post per player.
export const vrchatLinks = pgTable("vrchat_links", {
  discordId: text("discord_id").primaryKey(),
  discordUsername: text("discord_username").notNull(),
  discordGlobalName: text("discord_global_name"),
  vrchatUserId: text("vrchat_user_id").notNull(),
  vrchatUsername: text("vrchat_username").notNull(),
  vrchatUrl: text("vrchat_url").notNull(),
  sourceMessageId: text("source_message_id"),
  sourcePostedAt: timestamp("source_posted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
export type VrchatLink = typeof vrchatLinks.$inferSelect;

export const lifestyleTiers = pgTable("lifestyle_tiers", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  // Eddies debited monthly alongside rent. 0 is allowed (e.g. Street).
  monthlyCost: integer("monthly_cost").notNull().default(0),
  description: text("description"),
  archived: boolean("archived").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
export type LifestyleTier = typeof lifestyleTiers.$inferSelect;

// Pending character edits awaiting fixer/admin review.
//
// Workflow: a character owner submits PATCH /characters/:id with the fields
// they want changed. Instead of applying the diff to the live `characters`
// row, the server stores the partial payload here as `proposedDiff` and
// notifies the approval channel on Discord. Approvers vote via
// `pendingEditApprovals` rows; once a MAJORITY of distinct eligible voters
// (FIXER + CS_APPROVER + ADMIN, excluding the submitter themselves so
// staff can't self-approve) approve, the edit is applied and status flips
// to "approved". A majority rejection flips to "rejected". The submitter
// may "cancel" their own pending edit while it's still pending.
//
// Only one PENDING edit may exist per character at a time — the route
// layer guards this so reviewers always see a single coherent diff per
// character (and so a player can't queue 50 edits at once).
export const pendingCharacterEdits = pgTable("pending_character_edits", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id")
    .notNull()
    .references(() => characters.id, { onDelete: "cascade" }),
  // The user who proposed the edit. They may NOT vote on it themselves
  // (route enforces), and they ARE excluded from the eligible-voter pool
  // when computing the majority threshold.
  submittedBy: text("submitted_by")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // Partial PATCH payload — only the fields the submitter intends to
  // change. Shape mirrors CharacterUpdateSchema (name?, archetype?,
  // background?, portraitUrl?, portraitUrls?, statsImageUrls?, sheetData?,
  // lifeStatus?). Applied verbatim on approve, ignored on reject/cancel.
  proposedDiff: jsonb("proposed_diff").notNull(),
  // Snapshot of the character fields named in proposedDiff *at submission
  // time*. Used so the reviewer's before/after view doesn't drift if the
  // underlying character changes (admin script, other edit) between
  // submission and decision. Shape: { [field]: prevValue }.
  beforeSnapshot: jsonb("before_snapshot").notNull().default(sql`'{}'::jsonb`),
  // Player-supplied commit-message-style summary of the change. Surfaced
  // in the reviewer UI and written into character_updates on approval.
  updateNote: text("update_note"),
  // pending | approved | rejected | cancelled | changes_requested. A reviewer
  // can "request changes" which parks the edit in changes_requested (waiting on
  // the submitter); the submitter resubmits to send it back to pending.
  status: text("status").notNull().default("pending"),
  decisionSummary: text("decision_summary"),
  // Free-text comment a reviewer leaves when requesting changes. Surfaced to
  // the submitter; cleared on resubmit.
  reviewComment: text("review_comment"),
  // Admin who used "approve override" to bypass the majority vote (nullable).
  overriddenBy: text("overridden_by").references(() => users.id),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  // Archive lifecycle (see custom_requests). Closing an approved edit applies
  // the proposed diff to the character; closing a rejected edit just archives it.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: text("closed_by").references(() => users.id),
  // The resolved status the edit had at close time (approved | rejected |
  // cancelled). Preserved because closing overwrites `status` with "closed".
  // Null on legacy closed rows where it wasn't recoverable.
  closedOutcome: text("closed_outcome"),
  discordMessageId: text("discord_message_id"),
  // Discord thread mirroring this ticket's review discussion (read-only on the
  // portal; the website never posts to it).
  discordThreadId: text("discord_thread_id"),
}, (t) => ({
  pendingPerCharacterIdx: uniqueIndex("pending_edit_one_per_char_idx")
    .on(t.characterId)
    .where(sql`status = 'pending'`),
}));
export type PendingCharacterEdit = typeof pendingCharacterEdits.$inferSelect;

// One row per (edit, voter). A voter may switch their vote by upserting,
// hence the unique index — but the route only accepts one canonical vote
// per voter per edit (last write wins via upsert).
export const pendingEditApprovals = pgTable("pending_edit_approvals", {
  id: serial("id").primaryKey(),
  editId: integer("edit_id")
    .notNull()
    .references(() => pendingCharacterEdits.id, { onDelete: "cascade" }),
  voterId: text("voter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 'approve' | 'reject'. Stored as text to avoid an enum migration; the
  // route layer is the only writer and validates the value.
  vote: text("vote").notNull(),
  note: text("note"),
  votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneVotePerVoterIdx: uniqueIndex("pending_edit_vote_unique_idx").on(t.editId, t.voterId),
}));
export type PendingEditApproval = typeof pendingEditApprovals.$inferSelect;

// Generic majority-vote ledger reused by the review pipeline for entities that
// don't have their own approvals table — new character SHEETS (subjectType
// 'sheet') and custom/misc REQUESTS (subjectType 'request'). Character edits
// keep their dedicated pending_edit_approvals table. Same semantics: one
// canonical approve/reject vote per reviewer per subject (unique index), tallied
// against a majority threshold of eligible reviewers.
export const reviewVotes = pgTable("review_votes", {
  id: serial("id").primaryKey(),
  // 'sheet' | 'request' — the entity family this vote belongs to.
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  voterId: text("voter_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  // 'approve' | 'reject'. Stored as text; the route layer validates.
  vote: text("vote").notNull(),
  note: text("note"),
  votedAt: timestamp("voted_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneVotePerVoterIdx: uniqueIndex("review_vote_unique_idx").on(t.subjectType, t.subjectId, t.voterId),
  subjectIdx: index("review_vote_subject_idx").on(t.subjectType, t.subjectId),
}));
export type ReviewVote = typeof reviewVotes.$inferSelect;

// Two-way discussion thread on a review subject — character EDITS, custom
// REQUESTS, and character SHEETS. Both the submitter and any reviewer can post.
// Comments are PURELY a communication channel: they never change the subject's
// status, so leaving a comment never blocks an approval (unlike the older
// "request changes" flow). subjectType mirrors review_votes ('sheet' |
// 'request') plus 'edit' for character edits.
export const reviewComments = pgTable("review_comments", {
  id: serial("id").primaryKey(),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  authorId: text("author_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  subjectIdx: index("review_comment_subject_idx").on(t.subjectType, t.subjectId, t.createdAt),
}));
export type ReviewComment = typeof reviewComments.$inferSelect;

// Per-user "I have looked at this review subject" marker. Drives the unseen
// notification counts: an actionable subject counts toward a reviewer's badge
// until they open it (which upserts lastSeenAt = now). New activity on the
// subject (a fresh comment) bumps its activityAt past lastSeenAt, making it
// unseen again so the reviewer is re-notified that the player responded.
export const reviewSeen = pgTable("review_seen", {
  userId: text("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  subjectType: text("subject_type").notNull(),
  subjectId: integer("subject_id").notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.subjectType, t.subjectId] }),
}));
export type ReviewSeen = typeof reviewSeen.$inferSelect;

// In-portal notification feed. One row per user-facing event (request/edit/
// sheet/lore decision, mission application outcome, auto-charge, payout, new
// sale offer, NCPD fine, breach challenge, ...). Additive to Discord DMs —
// writers are fire-and-forget and must never block or fail the triggering
// action. `href` is a portal-relative link for the bell dropdown; `readAt`
// flips when the user opens the feed (mark-read).
export const notifications = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // Machine tag for the event family, e.g. "request_decision",
    // "mission_application", "auto_charge", "mission_payout", "sale_offer",
    // "ncpd_fine", "breach_challenge".
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    // Portal-relative link (e.g. "/missions/12"). Nullable for pure FYIs.
    href: text("href"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    readAt: timestamp("read_at", { withTimezone: true }),
  },
  (t) => ({
    userIdx: index("notifications_user_idx").on(t.userId, t.createdAt),
    // Fast unread-count lookups.
    unreadIdx: index("notifications_unread_idx").on(t.userId, t.readAt),
  }),
);
export type Notification = typeof notifications.$inferSelect;

// Per-character shop opens — one row per "the owner opened their venue
// today" event. The monthly_rent cron counts rows in the current month to
// scale a business lease's passive income. The UNIQUE (characterId, day)
// index makes the user-facing button idempotent: clicking twice on the
// same UTC day is a no-op. listingId is the housing lease the shop ran
// out of; nullable so we don't lose history if the lease is later deleted.
export const shopOpens = pgTable("shop_opens", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  listingId: integer("listing_id"),
  // UTC date the shop was opened (YYYY-MM-DD). Stored as a `date` column
  // — not a timestamp — so the unique index does the day-bucketing for us
  // without timezone surprises.
  openedOn: date("opened_on").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
  notes: text("notes"),
}, (t) => ({
  oneOpenPerDayIdx: uniqueIndex("shop_opens_one_per_day_idx").on(t.characterId, t.openedOn),
  charMonthIdx: index("shop_opens_char_month_idx").on(t.characterId, t.openedAt),
}));
export type ShopOpen = typeof shopOpens.$inferSelect;

// Per-user weekly attendance claims. One row = "user collected their
// €$250 weekly attend bonus for this session week." The week key is the
// Pacific (session-timezone) SUNDAY date of the session week (see
// sessionWeekKey in lib/sessionWindow.ts), not a Monday/ISO week. The
// UNIQUE (userId, weekStart) index is the entire correctness story —
// claim handler is just: insert, on conflict return 409.
export const attendanceClaims = pgTable("attendance_claims", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Pacific (session-timezone) Sunday date of the session week the claim
  // applies to (sessionWeekKey), stored as a YYYY-MM-DD date label.
  weekStart: date("week_start").notNull(),
  amount: integer("amount").notNull().default(250),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  oneClaimPerWeekIdx: uniqueIndex("attendance_one_per_week_idx").on(t.userId, t.weekStart),
}));
export type AttendanceClaim = typeof attendanceClaims.$inferSelect;

export const sessionsTable = pgTable("user_sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { withTimezone: false, precision: 6 }).notNull(),
});

// ---------------------------------------------------------------------------
// `bot_*` tables: mirror-imports of the legacy Discord-bot Replit DB.
// These are RAW IMPORTS — they preserve the bot's shape exactly so the portal
// can surface rent/cyberware/transaction history without re-modelling.
// All character/user references are Discord IDs (no FK to portal.users — the
// bot DB has rows for users who have never logged into the portal). Resolve
// to portal characters at READ TIME by joining bot.user_id → characters.ownerId.
// `botId` columns preserve the source-DB serial id for idempotent re-import.
// ---------------------------------------------------------------------------

// Per-mission pay log (one row per (user, mission) attendance grant).
export const botActorAttendance = pgTable("bot_actor_attendance", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").unique(),
  userId: text("user_id").notNull(),
  username: text("username"),
  missionId: text("mission_id"),
  missionName: text("mission_name"),
  fixerId: text("fixer_id"),
  fixerUsername: text("fixer_username"),
  payAmount: integer("pay_amount").notNull().default(0),
  actedAt: timestamp("acted_at", { withTimezone: true }).notNull(),
}, (t) => ({
  userIdx: index("bot_actor_attendance_user_idx").on(t.userId),
  actedIdx: index("bot_actor_attendance_acted_idx").on(t.actedAt),
}));

// Weekly attendance check-ins from the bot. Source has no primary key —
// we synthesize one and use (user, ts) as the dedup unique index.
export const botAttendanceLog = pgTable("bot_attendance_log", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  loggedAt: timestamp("logged_at", { withTimezone: true }).notNull(),
}, (t) => ({
  userTsIdx: uniqueIndex("bot_attendance_log_user_ts_idx").on(t.userId, t.loggedAt),
}));

// THE transaction ledger. Every cash/bank delta the bot applied lives here,
// with a free-text reason ("Fixer store-add gun", "rent ...", etc.).
export const botBalanceHistory = pgTable("bot_balance_history", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").unique(),
  userId: text("user_id").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  cashDelta: integer("cash_delta").notNull().default(0),
  bankDelta: integer("bank_delta").notNull().default(0),
  reason: text("reason"),
}, (t) => ({
  userIdx: index("bot_balance_history_user_idx").on(t.userId),
  tsIdx: index("bot_balance_history_ts_idx").on(t.ts),
}));

// Per-payment rent/bill events parsed from the legacy bot's #rent-payments
// Discord channel. The bot posted one confirmation line per charge during each
// monthly rent sweep (e.g. "✅ <@id> — Housing Rent paid: $2000"), going back a
// full year — far deeper than bot_balance_history's snapshot. Keyed by Discord
// message id so re-importing is idempotent. amount is the eddies charged
// (stored positive). PER DISCORD USER (the bot tracked rent per account).
export const botRentPaymentEvents = pgTable("bot_rent_payment_events", {
  id: serial("id").primaryKey(),
  messageId: text("message_id").notNull().unique(),
  userId: text("user_id").notNull(),
  ts: timestamp("ts", { withTimezone: true }).notNull(),
  // baseline | housing_rent | business_rent | membership | trauma_team |
  // cyberware_meds | other
  kind: text("kind").notNull(),
  label: text("label").notNull(),
  amount: integer("amount").notNull().default(0),
  week: integer("week"),
}, (t) => ({
  userIdx: index("bot_rent_payment_events_user_idx").on(t.userId),
  tsIdx: index("bot_rent_payment_events_ts_idx").on(t.ts),
}));

// Cyberware "weeks since last checkup" counter. PER USER (not per character)
// — that is just how the bot tracks it. Per-character cyberware ITEMS live
// in botPlayerInventory.
export const botCyberwareStatus = pgTable("bot_cyberware_status", {
  userId: text("user_id").primaryKey(),
  weeks: integer("weeks").notNull().default(0),
  lastProcessed: timestamp("last_processed", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// One row per cyberware sweep run: which users were charged, skipped, or
// had a checkup. checkup/paid/unpaid are arrays of Discord IDs.
export const botCyberwareWeeklyRuns = pgTable("bot_cyberware_weekly_runs", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").unique(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  checkupIds: jsonb("checkup_ids").notNull().default(sql`'[]'::jsonb`),
  paidIds: jsonb("paid_ids").notNull().default(sql`'[]'::jsonb`),
  unpaidIds: jsonb("unpaid_ids").notNull().default(sql`'[]'::jsonb`),
});

// Latest rent-payment debug summary text per user (one row per user, the
// bot overwrites it on each rent run).
export const botLastPayment = pgTable("bot_last_payment", {
  userId: text("user_id").primaryKey(),
  summary: text("summary"),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// Free-form per-user tags ("collect_rent_after", etc.) with a timestamp.
// Unique on (user, label, ts) so re-running the import is a no-op.
export const botPaymentLabels = pgTable("bot_payment_labels", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  label: text("label").notNull(),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
}, (t) => ({
  composite: uniqueIndex("bot_payment_labels_user_label_ts_idx").on(t.userId, t.label, t.recordedAt),
}));

// When each rent sweep was kicked off (one row per run).
export const botRentRuns = pgTable("bot_rent_runs", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").unique(),
  runAt: timestamp("run_at", { withTimezone: true }).notNull(),
  initiatedBy: text("initiated_by"),
});

// Fixer / ripperdoc store stock. store_id is the bot's "guild:owner" key.
export const botStoreInventory = pgTable("bot_store_inventory", {
  id: serial("id").primaryKey(),
  botId: integer("bot_id").unique(),
  storeId: text("store_id").notNull(),
  lotId: text("lot_id"),
  gunName: text("gun_name"),
  gunLevel: text("gun_level"),
  unitCost: integer("unit_cost").notNull().default(0),
  qty: integer("qty").notNull().default(0),
  itemIds: jsonb("item_ids").notNull().default(sql`'[]'::jsonb`),
  restriction: text("restriction"),
  weaponType: text("weapon_type"),
  gunCategory: text("gun_category"),
  createdAt: timestamp("created_at", { withTimezone: true }),
}, (t) => ({
  storeIdx: index("bot_store_inventory_store_idx").on(t.storeId),
}));

// Discord ticket message index — message_id is naturally unique so we use it
// as the primary key.
export const botTicketIndex = pgTable("bot_ticket_index", {
  messageId: text("message_id").primaryKey(),
  url: text("url"),
  ts: timestamp("ts", { withTimezone: true }),
  title: text("title"),
  body: text("body"),
}, (t) => ({
  tsIdx: index("bot_ticket_index_ts_idx").on(t.ts),
}));

// Per-user mission aggregate from the bot (parallel date+title arrays).
export const botMissionLog = pgTable("bot_mission_log", {
  userId: text("user_id").primaryKey(),
  username: text("username"),
  missionCount: integer("mission_count").notNull().default(0),
  missionDates: jsonb("mission_dates").notNull().default(sql`'[]'::jsonb`),
  missionTitles: jsonb("mission_titles").notNull().default(sql`'[]'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }),
});

// Shop-open events from the bot.
export const botBusinessOpenLog = pgTable("bot_business_open_log", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
}, (t) => ({
  composite: uniqueIndex("bot_business_open_user_ts_idx").on(t.userId, t.openedAt),
  userIdx: index("bot_business_open_user_idx").on(t.userId),
}));

// Bot's player inventory (distinct from portal.inventory_items — kept as a
// separate read-only mirror so we can surface bot-era item history without
// migrating live inventory state).
export const botPlayerInventory = pgTable("bot_player_inventory", {
  itemId: text("item_id").primaryKey(),
  ownerId: text("owner_id"),
  characterId: text("character_id"),
  characterName: text("character_name"),
  itemType: text("item_type"),
  name: text("name"),
  restriction: text("restriction"),
  description: text("description"),
  pricePaid: integer("price_paid"),
  sellerId: text("seller_id"),
  sellerName: text("seller_name"),
  acquiredAt: timestamp("acquired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }),
  powerLevel: text("power_level"),
  weaponSubtype: text("weapon_subtype"),
  cwp: text("cwp"),
  slot: text("slot"),
  weaponType: text("weapon_type"),
}, (t) => ({
  ownerIdx: index("bot_player_inventory_owner_idx").on(t.ownerId),
  charIdx: index("bot_player_inventory_char_idx").on(t.characterName),
}));

// ---------------------------------------------------------------------------
// LORE DIRECTORY
// ---------------------------------------------------------------------------
// World-lore entries surfaced under the Directory (Corporations / Gangs /
// Factions / Miscellaneous). Each entry carries a PUBLIC body anyone can read
// plus an optional FIXER-ONLY body and source references visible only to
// staff. A "Story Lead" fixer (free-text name) is shown near the top as the
// person responsible for the entry. Staff (fixer/admin) author entries; fixer
// edits go through admin approval (see lorePendingEdits) while admins publish
// directly. Imported lore lands in loreImportDrafts first (a staff review
// queue) and is only promoted into this table on approval.
export const loreEntries = pgTable("lore_entries", {
  id: serial("id").primaryKey(),
  // Category bucket: "corporation" | "gang" | "faction" | "misc".
  category: text("category").notNull().default("misc"),
  name: text("name").notNull(),
  // URL-stable identifier; unique, derived from name on create.
  slug: text("slug").notNull(),
  // Alternate names / abbreviations used for search + import dedup.
  aliases: text("aliases").array().notNull().default([]),
  // Free-text name of the responsible "Story Lead" fixer (not a user FK —
  // these are often NPC-handler handles that may not map to a portal account).
  responsibleFixer: text("responsible_fixer"),
  // One-line public blurb shown in the list + at the top of the detail page.
  summary: text("summary"),
  // Optional public image (object-storage path, e.g. /api/storage/objects/<id>).
  // Shown on the list card + detail page. Submitted via the same presigned-URL
  // upload flow as character portraits / gun images.
  imageUrl: text("image_url"),
  // Optional Night City district/location tag (e.g. "watson", "pacifica").
  // Matches a clickable region on the interactive district map; the map links
  // each district to the lore entry tagged with it. Free of a DB enum on
  // purpose — the canonical value list lives in the API layer.
  district: text("district"),
  // Optional sub-district (neighborhood) tag within `district` (e.g. "kabuki",
  // "japantown"). Matches a labeled neighborhood on the interactive map; the
  // canonical value list (and each value's parent district) lives in the API
  // layer. When set, `district` always holds its parent district.
  subDistrict: text("sub_district"),
  // Public markdown body — visible to everyone.
  publicBody: text("public_body").notNull().default(""),
  // Fixer-only markdown body — only ADMIN/FIXER may read.
  fixerBody: text("fixer_body"),
  // Staff-only source references: [{ label, url }]. Discord forum posts and
  // linked Google Docs the entry was sourced from.
  sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
  createdById: text("created_by_id").references(() => users.id),
  updatedById: text("updated_by_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex("lore_entries_slug_idx").on(t.slug),
  categoryIdx: index("lore_entries_category_idx").on(t.category),
  nameIdx: index("lore_entries_name_idx").on(t.name),
}));
export type LoreEntry = typeof loreEntries.$inferSelect;

// Fixer-proposed lore changes awaiting an admin decision. Surfaced in the
// unified Pending Requests page (Lore tab). Unlike character edits this is a
// single-admin approve/deny (no voting). A null loreEntryId means the fixer is
// proposing a brand-new entry (the full payload lives in proposedDiff); a set
// loreEntryId is an edit to an existing entry. proposedDiff is a partial set of
// entry fields; beforeSnapshot captures those same fields at submit time so the
// reviewer diff doesn't drift if the entry changes before a decision.
export const lorePendingEdits = pgTable("lore_pending_edits", {
  id: serial("id").primaryKey(),
  loreEntryId: integer("lore_entry_id").references(() => loreEntries.id, { onDelete: "cascade" }),
  // "edit" | "create".
  kind: text("kind").notNull().default("edit"),
  submittedBy: text("submitted_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  proposedDiff: jsonb("proposed_diff").notNull(),
  beforeSnapshot: jsonb("before_snapshot").notNull().default(sql`'{}'::jsonb`),
  updateNote: text("update_note"),
  status: text("status").notNull().default("pending"),
  decidedById: text("decided_by_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionSummary: text("decision_summary"),
  // Set to the admin user id when a proposal is approved (or denied) via the
  // admin override path, rather than reaching majority through votes.
  overriddenBy: text("overridden_by").references(() => users.id),
  // Set when an approved "create"/"edit" materializes the entry at close, so an
  // approval is never applied twice (the appliedRef idempotency guard). Stays
  // null while a proposal is only staged-approved (awaiting apply & close).
  appliedEntryId: integer("applied_entry_id"),
  // Set when a reviewer archives a resolved proposal at the apply & close step.
  // Drives terminal-bucket filtering, matching the other review queues.
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedBy: text("closed_by").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("lore_pending_edits_status_idx").on(t.status),
  entryIdx: index("lore_pending_edits_entry_idx").on(t.loreEntryId),
}));
export type LorePendingEdit = typeof lorePendingEdits.$inferSelect;

// Staging area for imported lore awaiting staff review. The importer scans the
// Discord lore forum + linked public Google Docs, groups/dedups candidates and
// writes one draft per proposed entry. Staff confirm category/fixer, set the
// public-vs-fixer split, optionally merge into an existing entry, then approve
// (which creates/updates a loreEntries row) or discard.
export const loreImportDrafts = pgTable("lore_import_drafts", {
  id: serial("id").primaryKey(),
  // Normalized grouping key (lowercased primary name) used to dedup candidates
  // that came from multiple sources (forum post + doc) into one draft.
  groupKey: text("group_key").notNull(),
  proposedName: text("proposed_name").notNull(),
  proposedCategory: text("proposed_category").notNull().default("misc"),
  proposedFixer: text("proposed_fixer"),
  aliases: text("aliases").array().notNull().default([]),
  summary: text("summary"),
  imageUrl: text("image_url"),
  // Mirror of lore_entries.district / sub_district for the import pipeline.
  district: text("district"),
  subDistrict: text("sub_district"),
  publicBody: text("public_body").notNull().default(""),
  fixerBody: text("fixer_body"),
  // Raw source references: [{ type: "discord"|"gdoc", url, title }].
  sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
  // If the importer (or staff) matched this draft to an existing entry, merge
  // into it on approval instead of creating a new one.
  suggestedMergeEntryId: integer("suggested_merge_entry_id").references(() => loreEntries.id, { onDelete: "set null" }),
  // "pending" | "approved" | "discarded".
  status: text("status").notNull().default("pending"),
  // Idempotency: dedup re-runs against the same source so the same forum thread
  // isn't imported twice while still pending.
  sourceKey: text("source_key"),
  decidedById: text("decided_by_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  appliedEntryId: integer("applied_entry_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("lore_import_drafts_status_idx").on(t.status),
  groupKeyIdx: index("lore_import_drafts_group_key_idx").on(t.groupKey),
  sourceKeyIdx: index("lore_import_drafts_source_key_idx").on(t.sourceKey),
  // DB-level idempotency: at most one *pending* draft per group, so concurrent
  // import runs can't both insert the same group. Resolved drafts (approved/
  // discarded) are excluded so a group can be re-imported after a decision.
  pendingGroupUnique: uniqueIndex("lore_import_drafts_pending_group_uq")
    .on(t.groupKey)
    .where(sql`status = 'pending'`),
}));
export type LoreImportDraft = typeof loreImportDrafts.$inferSelect;

// ---------------------------------------------------------------------------
// GUIDEBOOK
// ---------------------------------------------------------------------------
// Browsable NCRP reference content (Getting Started, FAQ, Rules, Schedule,
// Systems, Setup, NPC Acting, Character Creation Help) surfaced as its own
// top-level nav entry. Each page carries a Markdown body rendered as clean web
// content. Pages are grouped into fixed sections (see GUIDEBOOK_SECTIONS in the
// route). Mirrors the Lore system: admins create/edit/publish directly; fixers
// propose changes that an admin approves (see guidebookPendingEdits).
//
// Unlike Lore (which stages imports in a draft queue), the Guidebook importer
// upserts DIRECTLY into live pages keyed by discordChannelId: a new source
// inserts a page; re-importing a source whose page has NOT been edited on the
// site overwrites it in place; re-importing a source whose page WAS edited
// stashes the fresh content in pendingImport (rather than clobbering the manual
// edit) for an admin to apply or dismiss in the import-review screen.
export const guidebookPages = pgTable("guidebook_pages", {
  id: serial("id").primaryKey(),
  // Section bucket key (e.g. "getting_started" | "faq" | "rules" | ...).
  section: text("section").notNull().default("misc"),
  title: text("title").notNull(),
  // URL-stable identifier; unique, derived from title on create.
  slug: text("slug").notNull(),
  // One-line blurb shown under the title.
  description: text("description"),
  // Markdown body — rendered as clean web content (headings, lists, links,
  // inline images). Images are re-hosted to object storage at import time and
  // embedded inline as markdown so CDN expiry can't break them.
  body: text("body").notNull().default(""),
  // Re-hosted image object-storage paths embedded in the body (kept for
  // traceability / re-import). [string, ...].
  images: jsonb("images").notNull().default(sql`'[]'::jsonb`),
  // Display source references: [{ label, url }]. The originating Discord
  // channel(s) the page was imported from.
  sources: jsonb("sources").notNull().default(sql`'[]'::jsonb`),
  // Ordering within the section.
  position: integer("position").notNull().default(0),
  // Originating Discord channel id — the idempotency key for re-import. Null
  // for manually-authored pages (e.g. Character Creation Help). A unique index
  // (Postgres treats NULLs as distinct) prevents duplicate pages per source.
  discordChannelId: text("discord_channel_id"),
  // Human-readable source name (e.g. the channel name) for search + admin view.
  sourceLabel: text("source_label"),
  importedAt: timestamp("imported_at", { withTimezone: true }),
  // Flipped true on any admin/approved-fixer body edit; controls whether a
  // re-import overwrites in place or stashes a conflict in pendingImport.
  editedSinceImport: boolean("edited_since_import").notNull().default(false),
  // Fresh imported content awaiting admin review when the page was edited after
  // import: { title, description, body, images, sources, sourceLabel }.
  pendingImport: jsonb("pending_import"),
  pendingImportAt: timestamp("pending_import_at", { withTimezone: true }),
  createdById: text("created_by_id").references(() => users.id),
  updatedById: text("updated_by_id").references(() => users.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  slugIdx: uniqueIndex("guidebook_pages_slug_idx").on(t.slug),
  sectionIdx: index("guidebook_pages_section_idx").on(t.section),
  channelIdx: uniqueIndex("guidebook_pages_channel_idx").on(t.discordChannelId),
}));
export type GuidebookPage = typeof guidebookPages.$inferSelect;

// Fixer-proposed Guidebook changes awaiting an admin decision. Surfaced in the
// unified Pending Requests page (Guidebook tab). Single-admin approve/deny (no
// voting), mirroring lorePendingEdits. A null pageId means a brand-new page is
// proposed (full payload in proposedDiff); a set pageId is an edit.
export const guidebookPendingEdits = pgTable("guidebook_pending_edits", {
  id: serial("id").primaryKey(),
  pageId: integer("page_id").references(() => guidebookPages.id, { onDelete: "cascade" }),
  // "edit" | "create".
  kind: text("kind").notNull().default("edit"),
  submittedBy: text("submitted_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  proposedDiff: jsonb("proposed_diff").notNull(),
  beforeSnapshot: jsonb("before_snapshot").notNull().default(sql`'{}'::jsonb`),
  updateNote: text("update_note"),
  status: text("status").notNull().default("pending"),
  decidedById: text("decided_by_id").references(() => users.id),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decisionSummary: text("decision_summary"),
  // Set when an approved "create" materializes a new page, so an approval is
  // never applied twice.
  appliedPageId: integer("applied_page_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  statusIdx: index("guidebook_pending_edits_status_idx").on(t.status),
  pageIdx: index("guidebook_pending_edits_page_idx").on(t.pageId),
}));
export type GuidebookPendingEdit = typeof guidebookPendingEdits.$inferSelect;

// ---------------------------------------------------------------------------
// BREACH PROTOCOL (hacking minigame)
// ---------------------------------------------------------------------------
// A Fixer/Admin generates a timed Breach Protocol puzzle at a chosen difficulty
// and assigns it to a single player+character. The puzzle definition, its
// assignment, and the player's one-shot attempt all live in this single row:
// the puzzle is generated for exactly one assignee and is solved at most once.
// On a successful solve the row carries an optional reward (eddies and/or a
// single item) that is paid out exactly once (rewardPaidAt guards idempotency).
export const breachPuzzles = pgTable("breach_puzzles", {
  id: serial("id").primaryKey(),
  // Staff member (fixer/admin) who generated + sent the puzzle.
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The player the puzzle was sent to (the only account allowed to play/submit).
  assignedUserId: text("assigned_user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // The character context (for per-character history). Nullable so the row
  // survives a character deletion; the player history still works via user id.
  assignedCharacterId: integer("assigned_character_id").references(() => characters.id, { onDelete: "set null" }),
  // Display snapshot so history survives renames / deletions.
  assignedCharacterName: text("assigned_character_name"),
  // "easy" | "medium" | "hard" | "impossible".
  difficulty: text("difficulty").notNull(),
  timeLimitSeconds: integer("time_limit_seconds").notNull(),
  // The generated code matrix (string[][] of hex bytes) and daemon sequences
  // (string[][]). The "answer" is embedded in the grid itself — there is no
  // separate solution to hide, the challenge is finding a legal path.
  grid: jsonb("grid").notNull(),
  daemons: jsonb("daemons").notNull(),
  bufferSize: integer("buffer_size").notNull(),
  // Number of distinct legal solutions (0 => impossible by design).
  solutionCount: integer("solution_count").notNull(),
  // Optional reward paid on success.
  rewardEddies: integer("reward_eddies").notNull().default(0),
  rewardItemName: text("reward_item_name"),
  rewardItemCategory: text("reward_item_category"),
  rewardNote: text("reward_note"),
  // Optional free-text mission / event / custom context this puzzle is tied to
  // (staff-only; surfaced in the breach log for tracking). When the staff member
  // links a real mission, contextLabel holds a snapshot of its title.
  contextLabel: text("context_label"),
  // Optional hard link to a real mission. When set, the breach shows up on that
  // mission's detail page. Nullable + set-null on delete so the breach survives
  // mission deletion (the contextLabel title snapshot still describes it).
  missionId: integer("mission_id").references(() => missions.id, { onDelete: "set null" }),
  // Lifecycle: "sent" | "in_progress" | "success" | "partial" | "failed" | "expired".
  // "partial" = solved at least one but not all daemons (recorded, no reward).
  status: text("status").notNull().default("sent"),
  // Server-authoritative timer anchor (set on the first start call).
  startedAt: timestamp("started_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  // The player's final selected path (Pos[]) and how many daemons it breached.
  selection: jsonb("selection"),
  solvedCount: integer("solved_count").notNull().default(0),
  timeTakenSeconds: integer("time_taken_seconds"),
  // Idempotency guard + linkage for the reward payout.
  rewardPaidAt: timestamp("reward_paid_at", { withTimezone: true }),
  rewardLedgerId: integer("reward_ledger_id"),
  rewardItemId: integer("reward_item_id"),
  // When the assignment DM was successfully delivered (null => DM failed/pending).
  dmSentAt: timestamp("dm_sent_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  assignedUserIdx: index("breach_puzzles_assigned_user_idx").on(t.assignedUserId),
  assignedCharIdx: index("breach_puzzles_assigned_char_idx").on(t.assignedCharacterId),
  statusIdx: index("breach_puzzles_status_idx").on(t.status),
  createdByIdx: index("breach_puzzles_created_by_idx").on(t.createdBy),
}));
export type BreachPuzzle = typeof breachPuzzles.$inferSelect;

// ---------------------------------------------------------------------------
// BREACH PRACTICE STATS (opt-in, account-synced)
// ---------------------------------------------------------------------------
// The Breach *practice* page is deliberately "not recorded" — no economy, no
// rewards, no staff visibility. By default practice progress lives only in the
// player's browser localStorage. A logged-in player may OPT IN to mirror their
// own personal practice stats (attempts / solves / fastest clear) to their
// account so the numbers follow them across devices. One row per
// (user, difficulty). Opting into sync also opts the player into the practice
// fastest-clear leaderboard (by username). This table stays out of the economy,
// rewards, and the server-authoritative breachPuzzles flow.
export const breachPracticeStats = pgTable("breach_practice_stats", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // "easy" | "medium" | "hard" | "impossible".
  difficulty: text("difficulty").notNull(),
  attempts: integer("attempts").notNull().default(0),
  solves: integer("solves").notNull().default(0),
  // Best (smallest) clear time in ms; null until the player solves one.
  fastestClearMs: integer("fastest_clear_ms"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.difficulty] }),
}));
export type BreachPracticeStat = typeof breachPracticeStats.$inferSelect;

// One row per successful practice clear. Unlike breachPracticeStats (which keeps
// a single best-time aggregate per user/difficulty), this records every winning
// run so the leaderboard can rank INDIVIDUAL run times — a single player can
// therefore occupy several (or all) of the top slots in a difficulty. Stays out
// of the economy/rewards; purely a friendly fastest-time ranking.
export const breachPracticeClears = pgTable("breach_practice_clears", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // "easy" | "medium" | "hard" | "very_hard" | "nightmare".
  difficulty: text("difficulty").notNull(),
  // Clear time of this single run in ms (always present — only wins are stored).
  clearMs: integer("clear_ms").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  rankIdx: index("bpc_rank_idx").on(t.difficulty, t.clearMs, t.createdAt),
  userIdx: index("bpc_user_idx").on(t.userId),
}));
export type BreachPracticeClear = typeof breachPracticeClears.$inferSelect;

// ---------------------------------------------------------------------------
// VRChat CyberPsycho control panel
// ---------------------------------------------------------------------------
// The portal is only a shared CONTROL PANEL. The actual VRChat work (reading the
// VRCX auth cookie, parsing the VRChat log, mass-blocking / unblocking via the
// playermoderations API) happens in a small local Python agent that each staffer
// runs on their OWN PC against their OWN VRChat account. The portal never talks
// to VRChat directly. There is exactly one agent per staff user.
//
// Auth between agent and portal is a bearer token: the agent downloads a
// personalized script with a freshly-minted token baked in; the portal only ever
// stores the sha256 hash of that token. Re-downloading supersedes the prior
// token; Revoke clears it. The token is NOT a Discord session — agent requests
// carry no cookie and are scoped purely to this one row.
export const vrchatAgents = pgTable("vrchat_agents", {
  // The staff user who owns this agent. One agent per user.
  userId: text("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  // sha256(token) hex. Null when never issued or after Revoke.
  tokenHash: text("token_hash"),
  tokenIssuedAt: timestamp("token_issued_at", { withTimezone: true }),
  // Optional friendly label the agent reports (e.g. machine / VRChat name).
  label: text("label"),
  // Updated on every agent poll — drives the online/offline indicator.
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // Latest full status snapshot the agent reported (psycho_active, blocked list,
  // allowlist, current instance occupants, operation progress, session_expired…).
  status: jsonb("status").$type<Record<string, unknown>>(),
  statusAt: timestamp("status_at", { withTimezone: true }),
  // Set by Revoke; while non-null the token (already cleared) cannot authenticate.
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type VrchatAgent = typeof vrchatAgents.$inferSelect;

// Command queue from the portal to a staffer's agent. The portal inserts a
// pending row; the agent claims it on its next poll, runs it locally, and reports
// the outcome back (flipping status to done/error). Idempotency for re-delivered
// stale-claimed rows is handled agent-side (block/unblock are tracked locally).
export const vrchatAgentCommands = pgTable(
  "vrchat_agent_commands",
  {
    id: serial("id").primaryKey(),
    // The agent (= staff user) this command is for.
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    // isolate | restore | refresh | snapshot | save_allowlist | restart_vrchat
    kind: text("kind").notNull(),
    // Command-specific payload, e.g. { allowlist: [{ id, name }] } for save_allowlist.
    params: jsonb("params").$type<Record<string, unknown>>(),
    // pending | claimed | done | error
    status: text("status").notNull().default("pending"),
    // Structured result the agent reported (e.g. counts, message).
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    // The staff user who issued the command (= userId for self-service, but kept
    // separate so an admin-issued command stays attributable).
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    queueIdx: index("vrchat_cmd_queue_idx").on(t.userId, t.status, t.id),
  }),
);
export type VrchatAgentCommand = typeof vrchatAgentCommands.$inferSelect;

// Persisted VRChat API session for the dedicated 24/7 "instance browser"
// account. The auth + twoFactorAuth cookies are reused across polls so we only
// run the (rate-limited) login + 2FA flow rarely. A fixed sentinel id keeps at
// most one row. Cookie values are NEVER logged or returned to clients.
export const vrchatSessions = pgTable("vrchat_sessions", {
  id: integer("id").primaryKey().default(1),
  // Raw cookie VALUES (not name=value) replayed on each authenticated call.
  authCookie: text("auth_cookie"),
  twoFactorCookie: text("two_factor_cookie"),
  // Auth cookie captured mid-login while waiting for a human to paste the email
  // one-time code (emailOtp). Promoted to authCookie once verify succeeds.
  pendingAuthCookie: text("pending_auth_cookie"),
  // Resolved account identity (diagnostic; surfaced to staff only).
  vrchatUserId: text("vrchat_user_id"),
  vrchatDisplayName: text("vrchat_display_name"),
  // Last successful authenticated call — drives a staff "session healthy" badge.
  lastAuthAt: timestamp("last_auth_at", { withTimezone: true }),
  // Last login/auth/poll error surfaced to staff (cleared on success).
  lastError: text("last_error"),
  // Start of the current disconnected episode (auth cookie gone). Set by the
  // maintenance cron when it first sees the session down; cleared on any
  // successful (re)connect. Drives the alert grace window: admins are only
  // paged if the session has stayed down past the grace period, after the
  // automatic reconnect has had at least two attempts.
  disconnectedSince: timestamp("disconnected_since", { withTimezone: true }),
  // Last time admins were alerted about a disconnect. Persisted (not in-process)
  // so overlapping server instances can't each fire their own alert; the alert
  // is claimed via a conditional UPDATE on this column.
  lastDisconnectNotifyAt: timestamp("last_disconnect_notify_at", { withTimezone: true }),
  // Last unattended auto-reconnect (login) attempt. Persisted (not in-process)
  // so multiple server instances can't each fire their own login within the
  // cooldown — a login stampede from one IP makes VRChat invalidate the fresh
  // sessions, turning one expiry into an expire/reconnect loop. Claimed via a
  // conditional UPDATE on this column; only the winner performs the login.
  lastAutoReconnectAt: timestamp("last_auto_reconnect_at", { withTimezone: true }),
  // Last claimed instance-poll tick. Claimed via conditional UPDATE (like the
  // reconnect cooldown) so only ONE server instance talks to VRChat per poll
  // cycle. Concurrent same-account polls race VRChat's cookie rotation: the
  // instance still holding the pre-rotation cookie gets a real 401, confirms
  // the (rotated-away) cookie dead, and password-relogins — invalidating the
  // other instance's fresh session and looping expire/reconnect every ~14 min
  // whenever autoscale runs >1 instance (observed 2026-07-26).
  lastPollTickAt: timestamp("last_poll_tick_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type VrchatSession = typeof vrchatSessions.$inferSelect;

// Cache of currently-open NCRP VRChat group instances, refreshed by a poller so
// members never hit the VRChat API directly (rate limits). A row exists only
// while the instance is open; the poller prunes rows it no longer sees.
export const vrchatInstances = pgTable("vrchat_instances", {
  // Full VRChat location string ("wrld_xxx:12345~group(grp_..)~..."). Stable id.
  location: text("location").primaryKey(),
  worldId: text("world_id").notNull(),
  worldName: text("world_name").notNull(),
  thumbnailUrl: text("thumbnail_url"),
  // Short numeric instance id (part before the first '~'), for display.
  instanceShortId: text("instance_short_id").notNull(),
  // Full instanceId token (with access-type suffixes) for the launch URL.
  instanceId: text("instance_id").notNull(),
  // Normalised access type: group_public | group_plus | group_members |
  // invite_plus | friends_plus | invite | public | unknown.
  accessType: text("access_type").notNull().default("unknown"),
  region: text("region"),
  userCount: integer("user_count").notNull().default(0),
  capacity: integer("capacity"),
  // Group role IDs allowed to join (only populated for role-restricted group
  // instances; empty/absent otherwise) and their resolved display names. Names
  // are resolved at poll time from the group's roles so the read path never has
  // to hit the rate-limited VRChat API.
  roleIds: jsonb("role_ids").$type<string[]>(),
  roleNames: jsonb("role_names").$type<string[]>(),
  // Server-side first-seen → uptime baseline (VRChat exposes no reliable
  // instance creation time). Persisted across polls while the instance lives.
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  // Full normalised snapshot for debugging / future fields.
  raw: jsonb("raw").$type<Record<string, unknown>>(),
});
export type VrchatInstance = typeof vrchatInstances.$inferSelect;

// Historical record of VRChat group instance sessions: one row per instance
// lifetime (opened → closed), written by the same poller that maintains the
// live vrchat_instances cache. `source` distinguishes live-poll rows from
// VRCX-imported historical rows; uniqueUsers is only knowable for VRCX rows
// (the group-instances API returns head counts, never identities).
export const vrchatInstanceSessions = pgTable(
  "vrchat_instance_sessions",
  {
    id: serial("id").primaryKey(),
    location: text("location").notNull(),
    worldId: text("world_id").notNull(),
    worldName: text("world_name").notNull(),
    accessType: text("access_type").notNull().default("unknown"),
    region: text("region"),
    source: text("source").notNull().default("live"), // live | vrcx
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    // NULL while the instance is still open; set when a successful poll no
    // longer lists the location.
    closedAt: timestamp("closed_at", { withTimezone: true }),
    peakUserCount: integer("peak_user_count").notNull().default(0),
    // Running sum + count of per-poll head-count samples → average occupancy.
    sampleCount: integer("sample_count").notNull().default(0),
    sumUserCounts: integer("sum_user_counts").notNull().default(0),
    capacity: integer("capacity"),
    // Distinct players seen in the instance — VRCX-imported rows only.
    uniqueUsers: integer("unique_users"),
  },
  (t) => ({
    // At most one OPEN live session per location (a location string can be
    // reused by a later instance, so uniqueness only applies while open).
    openLocationIdx: uniqueIndex("vis_open_location_idx")
      .on(t.location)
      .where(sql`closed_at IS NULL AND source = 'live'`),
    firstSeenIdx: index("vis_first_seen_idx").on(t.firstSeenAt),
  }),
);
export type VrchatInstanceSession = typeof vrchatInstanceSessions.$inferSelect;

// Per-poll head-count samples for a session (one row every poll tick) so we
// can chart occupancy over an instance's lifetime.
export const vrchatInstanceSamples = pgTable(
  "vrchat_instance_samples",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => vrchatInstanceSessions.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    userCount: integer("user_count").notNull().default(0),
  },
  (t) => ({
    sessionIdx: index("visamp_session_idx").on(t.sessionId),
  }),
);
export type VrchatInstanceSample = typeof vrchatInstanceSamples.$inferSelect;

// Per-player visits inside a session — only knowable from VRCX gamelog imports
// (the live group-instances API returns head counts, never identities).
export const vrchatInstanceVisits = pgTable(
  "vrchat_instance_visits",
  {
    id: serial("id").primaryKey(),
    sessionId: integer("session_id")
      .notNull()
      .references(() => vrchatInstanceSessions.id, { onDelete: "cascade" }),
    vrchatUserId: text("vrchat_user_id").notNull(),
    displayName: text("display_name").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull(),
    // NULL when no matching leave event was seen — the visit is treated as
    // lasting until the session's last event.
    leftAt: timestamp("left_at", { withTimezone: true }),
    durationMs: integer("duration_ms").notNull().default(0),
  },
  (t) => ({
    sessionIdx: index("viv_session_idx").on(t.sessionId),
    userIdx: index("viv_user_idx").on(t.vrchatUserId),
    nameIdx: index("viv_name_idx").on(sql`lower(${t.displayName})`),
    joinedIdx: index("viv_joined_idx").on(t.joinedAt),
  }),
);
export type VrchatInstanceVisit = typeof vrchatInstanceVisits.$inferSelect;

// ---------------------------------------------------------------------------
// NCPD (Night City Police Department)
// ---------------------------------------------------------------------------
// Officer-filed arrest reports, warrants, per-character NCPD notes and the
// Book of Laws. Records are visible ONLY to NCPD officers / fixers / admins —
// never to the character's owner. Laws are public, but severity / punishment /
// restricted notes are stripped server-side for non-privileged viewers.

// One arrest report, always attached to a specific character.
export const ncpdArrestReports = pgTable(
  "ncpd_arrest_reports",
  {
    id: serial("id").primaryKey(),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    // Filing officer. Snapshot the display name so the report stays legible
    // even if the user row is later deleted.
    officerId: text("officer_id").references(() => users.id, { onDelete: "set null" }),
    officerName: text("officer_name"),
    title: text("title").notNull(),
    // Free-form report body (markdown allowed in the portal renderer).
    body: text("body").notNull(),
    // Comma/newline separated list of charges as written by the officer.
    charges: text("charges"),
    // When the arrest happened in-world (officer-supplied; defaults to filing time).
    arrestedAt: timestamp("arrested_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    charIdx: index("ncpd_reports_char_idx").on(t.characterId),
  }),
);
export type NcpdArrestReport = typeof ncpdArrestReports.$inferSelect;

// An outstanding (or historical) warrant on a character.
export const ncpdWarrants = pgTable(
  "ncpd_warrants",
  {
    id: serial("id").primaryKey(),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    issuedByName: text("issued_by_name"),
    reason: text("reason").notNull(),
    // open | served | revoked. Open warrants surface on the NCPD dashboard.
    status: text("status").notNull().default("open"),
    // Optional internal detail (last-known whereabouts, cautions, etc).
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    charIdx: index("ncpd_warrants_char_idx").on(t.characterId),
    statusIdx: index("ncpd_warrants_status_idx").on(t.status),
  }),
);
export type NcpdWarrant = typeof ncpdWarrants.$inferSelect;

// Free-form NCPD notes on a character (surfaced in the records lookup and the
// staff-only character records tab).
export const ncpdCharacterNotes = pgTable(
  "ncpd_character_notes",
  {
    id: serial("id").primaryKey(),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => users.id, { onDelete: "set null" }),
    authorName: text("author_name"),
    note: text("note").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    charIdx: index("ncpd_notes_char_idx").on(t.characterId),
  }),
);
export type NcpdCharacterNote = typeof ncpdCharacterNotes.$inferSelect;

// The Book of Laws. `title` + `body` are public to every signed-in member;
// `severity` (misdemeanor | felony), `punishment` and `restrictedNotes` are
// stripped server-side unless the viewer is NCPD / fixer / admin. Writable by
// the Commissioner, fixers and admins.
export const ncpdLaws = pgTable("ncpd_laws", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  // Public statute text.
  body: text("body").notNull(),
  // misdemeanor | felony — restricted field.
  severity: text("severity"),
  // Restricted: sentencing guidance for officers.
  punishment: text("punishment"),
  // Restricted: internal enforcement notes.
  restrictedNotes: text("restricted_notes"),
  // Manual ordering for the public page (lower first, ties by id).
  sortOrder: integer("sort_order").notNull().default(0),
  createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});
export type NcpdLaw = typeof ncpdLaws.$inferSelect;

// A fine issued by an NCPD officer against a character. The officer sets the
// amount and a reason; the player (the character's CURRENT owner) pays it from
// their UnbelievaBoat wallet, which debits their balance and records a ledger
// row that surfaces in the character's transaction history. Status flips to
// 'paid' on payment (visible to the issuing officer on the dossier) and 'void'
// if the officer cancels an unpaid fine.
export const ncpdFines = pgTable(
  "ncpd_fines",
  {
    id: serial("id").primaryKey(),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    // Issuing officer. Snapshot the display name so the fine stays legible even
    // if the user row is later deleted.
    issuedById: text("issued_by_id").references(() => users.id, { onDelete: "set null" }),
    officerName: text("officer_name"),
    // Fine amount in eddies (always positive; debited from the payer on pay).
    amount: integer("amount").notNull(),
    reason: text("reason").notNull(),
    // unpaid | paid | void
    status: text("status").notNull().default("unpaid"),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    // The user who actually paid (the character's owner at payment time).
    paidByUserId: text("paid_by_user_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    charIdx: index("ncpd_fines_char_idx").on(t.characterId),
    statusIdx: index("ncpd_fines_status_idx").on(t.status),
  }),
);
export type NcpdFine = typeof ncpdFines.$inferSelect;

// A free-form NCPD case file: officers open one blank and write whatever the
// investigation needs (markdown body). Deliberately unstructured — not tied to
// a character; officers link suspects/evidence inline in the body text.
export const ncpdCaseFiles = pgTable(
  "ncpd_case_files",
  {
    id: serial("id").primaryKey(),
    title: text("title").notNull(),
    // Free-form case body (markdown allowed in the portal renderer).
    body: text("body").notNull().default(""),
    // open | closed. Open cases surface first on the case board.
    status: text("status").notNull().default("open"),
    // Opening officer. Snapshot the display name so the case stays legible
    // even if the user row is later deleted.
    openedById: text("opened_by_id").references(() => users.id, { onDelete: "set null" }),
    openedByName: text("opened_by_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => ({
    statusIdx: index("ncpd_case_files_status_idx").on(t.status),
  }),
);
export type NcpdCaseFile = typeof ncpdCaseFiles.$inferSelect;

// ---------------------------------------------------------------------------
// Analytics: weekly character activity snapshots
// ---------------------------------------------------------------------------
// One row per (week, PC character) recording whether the character counted as
// "active" that week under the analytics 60-day rule (any wallet movement,
// mission application, or mission assignment in the 60 days before the week's
// end). Written by the weekly `character_snapshot` job, which also backfills
// every missing past week — the rule is fully derivable from timestamped rows,
// so backfill and forward accrual share one code path. `lifeStatus` is the
// character's life status AT SNAPSHOT TIME for forward weeks; backfilled weeks
// carry the status current at backfill time (no historical status log exists).
export const characterWeekSnapshots = pgTable(
  "character_week_snapshots",
  {
    id: serial("id").primaryKey(),
    // Monday (date_trunc('week')) of the snapshot week, as a plain date.
    weekStart: date("week_start").notNull(),
    characterId: integer("character_id")
      .notNull()
      .references(() => characters.id, { onDelete: "cascade" }),
    active: boolean("active").notNull().default(false),
    lifeStatus: text("life_status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    weekCharIdx: uniqueIndex("cws_week_char_idx").on(t.weekStart, t.characterId),
    weekIdx: index("cws_week_idx").on(t.weekStart),
  }),
);
export type CharacterWeekSnapshot = typeof characterWeekSnapshots.$inferSelect;

// ---------------------------------------------------------------------------
// Community membership events (growth timeline)
// ---------------------------------------------------------------------------
// One row per observed join/leave of the Discord server or the VRChat group.
// Discord rows are parsed from the #ncrp-welcome system messages (joins) and
// the Dyno "Member Joined"/"Member Left" embeds in #bot-logs (both). VRChat
// rows come from the group audit log (prod-only poller). `sourceRef` is a
// stable per-observation key (message id / audit-log id) so ingestion is
// idempotent; welcome-channel joins that duplicate a bot-logs join within a
// few minutes are skipped at ingest time.
export const membershipEvents = pgTable(
  "membership_events",
  {
    id: serial("id").primaryKey(),
    // "discord" | "vrchat"
    source: text("source").notNull(),
    // "join" | "leave"
    direction: text("direction").notNull(),
    // Discord user id or VRChat usr_ id of the member the event is about.
    subjectId: text("subject_id").notNull(),
    displayName: text("display_name"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    // Raw upstream event type (e.g. "welcome-system", "dyno-embed",
    // "group.user.join") for forensics.
    eventType: text("event_type"),
    // Idempotency key, e.g. "discord-msg:<id>" or "vrchat-log:<id>".
    sourceRef: text("source_ref").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    refIdx: uniqueIndex("membership_events_ref_idx").on(t.sourceRef),
    srcTimeIdx: index("membership_events_src_time_idx").on(t.source, t.occurredAt),
    subjectIdx: index("membership_events_subject_idx").on(t.subjectId, t.occurredAt),
  }),
);
export type MembershipEvent = typeof membershipEvents.$inferSelect;
