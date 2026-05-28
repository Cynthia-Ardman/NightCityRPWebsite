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
  uuid,
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
    activeCharacterId: integer("active_character_id"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).defaultNow(),
    rolesSyncedAt: timestamp("roles_synced_at", { withTimezone: true }),
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
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  charIdx: index("wt_char_idx").on(t.characterId),
  userIdx: index("wt_user_idx").on(t.userId),
}));

export const stores = pgTable("stores", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerCharacterId: integer("owner_character_id"),
  name: text("name").notNull(),
  kind: text("kind").notNull().default("mixed"),
  location: text("location"),
  description: text("description"),
  bannerUrl: text("banner_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const storeEmployees = pgTable("store_employees", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("clerk"),
});

export const storeStock = pgTable("store_stock", {
  id: serial("id").primaryKey(),
  storeId: integer("store_id").notNull().references(() => stores.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  price: integer("price").notNull().default(0),
  quantity: integer("quantity").notNull().default(0),
  notes: text("notes"),
});

export const ripperdocs = pgTable("ripperdocs", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ownerCharacterId: integer("owner_character_id"),
  name: text("name").notNull(),
  location: text("location"),
  description: text("description"),
  bannerUrl: text("banner_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const ripperdocEmployees = pgTable("ripperdoc_employees", {
  id: serial("id").primaryKey(),
  ripperdocId: integer("ripperdoc_id").notNull().references(() => ripperdocs.id, { onDelete: "cascade" }),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("doc"),
});

export const ripperdocStock = pgTable("ripperdoc_stock", {
  id: serial("id").primaryKey(),
  ripperdocId: integer("ripperdoc_id").notNull().references(() => ripperdocs.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  price: integer("price").notNull().default(0),
  quantity: integer("quantity").notNull().default(0),
  notes: text("notes"),
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
  status: text("status").notNull().default("pending"),
  data: jsonb("data").notNull(),
  decisionBy: text("decision_by"),
  decisionNote: text("decision_note"),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  discordMessageId: text("discord_message_id"),
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
  notes: text("notes"),
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
});

export const jobRuns = pgTable("job_runs", {
  id: serial("id").primaryKey(),
  job: text("job").notNull(),
  status: text("status").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  message: text("message"),
  affectedCount: integer("affected_count"),
});

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
  monthlyRent: integer("monthly_rent").notNull().default(0),
  paidThrough: timestamp("paid_through", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  status: text("status").notNull().default("planned"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

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
  status: text("status").notNull().default("pending"),
  decisionSummary: text("decision_summary"),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  discordMessageId: text("discord_message_id"),
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

export const sessionsTable = pgTable("user_sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { withTimezone: false, precision: 6 }).notNull(),
});
