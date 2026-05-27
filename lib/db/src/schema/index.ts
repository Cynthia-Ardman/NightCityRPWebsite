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
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  archetype: text("archetype"),
  background: text("background"),
  portraitUrl: text("portrait_url"),
  discordChannelId: text("discord_channel_id"),
  approved: boolean("approved").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export type Character = typeof characters.$inferSelect;

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
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  category: text("category"),
  quantity: integer("quantity").notNull().default(1),
  notes: text("notes"),
  equipped: boolean("equipped").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const walletTransactions = pgTable("wallet_transactions", {
  id: serial("id").primaryKey(),
  characterId: integer("character_id").notNull().references(() => characters.id, { onDelete: "cascade" }),
  counterpartyCharacterId: integer("counterparty_character_id"),
  counterpartyName: text("counterparty_name"),
  amount: integer("amount").notNull(),
  kind: text("kind").notNull(),
  memo: text("memo"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  charIdx: index("wt_char_idx").on(t.characterId),
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
  notes: text("notes"),
});

export const catalogCyberware = pgTable("catalog_cyberware", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  slot: text("slot").notNull(),
  humanityLoss: integer("humanity_loss").notNull().default(0),
  price: integer("price").notNull().default(0),
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

export const sessionsTable = pgTable("user_sessions", {
  sid: text("sid").primaryKey(),
  sess: jsonb("sess").notNull(),
  expire: timestamp("expire", { withTimezone: false, precision: 6 }).notNull(),
});
