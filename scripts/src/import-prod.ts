/**
 * One-shot prod database importer.
 *
 * Reads from PROD_DATABASE_URL (read-only) and writes into DATABASE_URL.
 * Idempotent: re-running upserts by natural key and skips already-imported rows.
 *
 *   pnpm tsx scripts/import-prod.ts
 */
import pg from "pg";
import {
  db,
  users,
  characters,
  inventoryItems,
  walletTransactions,
  stores,
  storeStock,
  catalogGuns,
  catalogCyberware,
  missionLog,
  botConfig,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";

const PROD = process.env.PROD_DATABASE_URL;
if (!PROD) {
  console.error("PROD_DATABASE_URL not set");
  process.exit(1);
}

const prod = new pg.Client({ connectionString: PROD });
await prod.connect();
console.log("connected to prod (read-only)");

const counts = {
  users: 0,
  characters: 0,
  inventory_assigned: 0,
  inventory_unassigned: 0,
  ledger: 0,
  stores: 0,
  store_stock: 0,
  catalog_guns: 0,
  catalog_cyberware: 0,
  missions: 0,
  bot_config: 0,
};

// ---------- 1. USERS (synthesize from every discord_user_id we'll touch) ----------
const userIdRows = await prod.query<{ id: string; username: string | null }>(`
  WITH ids AS (
    SELECT discord_user_id AS id FROM characters
    UNION SELECT user_id FROM balance_history
    UNION SELECT owner_id FROM wholesaler_stores WHERE owner_id IS NOT NULL
    UNION SELECT owner_id FROM player_inventory WHERE owner_id IS NOT NULL
    UNION SELECT user_id FROM cyberware_status
    UNION SELECT user_id FROM actor_attendance
    UNION SELECT user_id FROM last_payment
  ),
  names AS (
    SELECT user_id AS id, username FROM actor_attendance
    UNION
    SELECT user_id AS id, username FROM mission_log
  )
  SELECT i.id, (SELECT username FROM names WHERE id = i.id LIMIT 1) AS username
  FROM ids i WHERE i.id IS NOT NULL
`);
console.log(`prod has ${userIdRows.rows.length} distinct discord user ids`);

for (const r of userIdRows.rows) {
  const username = r.username?.split("|")[0]?.trim() || `user_${r.id.slice(-6)}`;
  await db
    .insert(users)
    .values({ id: r.id, discordId: r.id, username, roles: [] })
    .onConflictDoNothing({ target: users.id });
  counts.users++;
}

// ---------- 2. CHARACTERS ----------
// Map prod char_id (uuid) -> local serial id.
const charMap = new Map<string, number>();
const ownerActiveChar = new Map<string, number>(); // first active char per owner, for fallback

const prodChars = await prod.query<{
  character_id: string;
  discord_user_id: string;
  character_name: string;
  status: string;
  created_at: Date;
  deactivated_at: Date | null;
}>(`SELECT character_id, discord_user_id, character_name, status, created_at, deactivated_at FROM characters ORDER BY created_at ASC`);

for (const c of prodChars.rows) {
  // Anchor mapping to the legacy character_id (uuid) so renames and duplicate
  // names within one owner cannot collide. We stamp the tag into `background`.
  const tag = `[legacy:${c.character_id}]`;
  const existing = await db
    .select({ id: characters.id })
    .from(characters)
    .where(sql`${characters.background} LIKE ${"%" + tag + "%"}`);
  let id: number;
  if (existing.length) {
    id = existing[0].id;
  } else {
    const [ins] = await db
      .insert(characters)
      .values({
        ownerId: c.discord_user_id,
        name: c.character_name,
        kind: "pc",
        background: tag,
        approved: true,
        archived: c.status !== "active",
        archivedAt: c.deactivated_at,
        createdAt: c.created_at,
      })
      .returning({ id: characters.id });
    id = ins.id;
    counts.characters++;
  }
  charMap.set(c.character_id, id);
  if (c.status === "active" && !ownerActiveChar.has(c.discord_user_id)) {
    ownerActiveChar.set(c.discord_user_id, id);
  }
}
console.log(`characters: ${counts.characters} new, ${charMap.size} total mapped`);

// ---------- 3. CATALOGS (prod wins on every field) ----------
const cwRows = await prod.query<{
  name: string;
  cwp: string;
  slot: string;
  description: string;
  price: number;
  wholesale_price: number;
}>(`SELECT name, cwp, slot, description, price, wholesale_price FROM cyberware_catalog`);
for (const r of cwRows.rows) {
  const found = await db.select({ id: catalogCyberware.id }).from(catalogCyberware).where(eq(catalogCyberware.name, r.name));
  if (found.length) {
    await db
      .update(catalogCyberware)
      .set({
        slot: r.slot,
        cwp: r.cwp,
        price: r.price,
        wholesalePrice: r.wholesale_price,
        description: r.description,
      })
      .where(eq(catalogCyberware.id, found[0].id));
  } else {
    await db.insert(catalogCyberware).values({
      name: r.name,
      slot: r.slot,
      cwp: r.cwp,
      price: r.price,
      wholesalePrice: r.wholesale_price,
      description: r.description,
    });
  }
  counts.catalog_cyberware++;
}

const gunRows = await prod.query<{
  gun_name: string;
  gun_level: string;
  price: number;
  wholesale_price: number;
  restriction: string;
  status: string;
  weapon_type: string;
  gun_category: string;
}>(`SELECT gun_name, gun_level, price, wholesale_price, restriction, status, weapon_type, gun_category FROM gun_catalog`);
for (const r of gunRows.rows) {
  const found = await db.select({ id: catalogGuns.id }).from(catalogGuns).where(eq(catalogGuns.name, r.gun_name));
  const vals = {
    category: r.gun_category,
    price: r.price,
    wholesalePrice: r.wholesale_price,
    restriction: r.restriction,
    status: r.status,
    powerLevel: r.gun_level,
    weaponType: r.weapon_type,
  };
  if (found.length) {
    await db.update(catalogGuns).set(vals).where(eq(catalogGuns.id, found[0].id));
  } else {
    await db.insert(catalogGuns).values({ name: r.gun_name, ...vals });
  }
  counts.catalog_guns++;
}

// ---------- 4. PLAYER INVENTORY ----------
// Rule: if character_id is set AND mapped -> assign to that character.
// If character_id is null/unknown AND owner has exactly one character -> assign to it.
// Otherwise -> leave unassigned (ownerId only, characterId null).
const invRows = await prod.query<{
  item_id: string;
  owner_id: string;
  character_id: string | null;
  item_type: string;
  name: string;
  description: string;
  price_paid: number | null;
  acquired_at: Date | null;
  cwp: string | null;
  slot: string | null;
  power_level: string | null;
  weapon_type: string | null;
}>(`SELECT item_id, owner_id, character_id, item_type, name, description, price_paid, acquired_at, cwp, slot, power_level, weapon_type FROM player_inventory`);

// Count characters per owner for the single-char fallback.
const ownerCharCount = new Map<string, number>();
for (const c of prodChars.rows) {
  ownerCharCount.set(c.discord_user_id, (ownerCharCount.get(c.discord_user_id) ?? 0) + 1);
}

for (const r of invRows.rows) {
  const tag = `[legacy-item:${r.item_id}]`;
  // Skip if already imported. notes is "[legacy-item:<id>] <meta>", so match by prefix.
  const dupe = await db
    .select({ id: inventoryItems.id })
    .from(inventoryItems)
    .where(sql`${inventoryItems.notes} LIKE ${tag + "%"}`);
  if (dupe.length) continue;

  let charId: number | null = null;
  if (r.character_id && charMap.has(r.character_id)) {
    charId = charMap.get(r.character_id)!;
  } else if ((ownerCharCount.get(r.owner_id) ?? 0) === 1) {
    charId = ownerActiveChar.get(r.owner_id) ?? null;
  }

  const meta = [r.cwp && `CWP ${r.cwp}`, r.slot, r.power_level, r.weapon_type, r.description]
    .filter(Boolean)
    .join(" · ");

  await db.insert(inventoryItems).values({
    characterId: charId,
    ownerId: r.owner_id,
    name: r.name,
    category: r.item_type,
    quantity: 1,
    notes: `${tag} ${meta}`.trim(),
    pricePaid: r.price_paid,
    acquiredAt: r.acquired_at,
  });
  if (charId) counts.inventory_assigned++;
  else counts.inventory_unassigned++;
}

// ---------- 5. WALLET LEDGER (full history, all 645 rows) ----------
const balRows = await prod.query<{
  id: string;
  user_id: string;
  ts: Date;
  cash_delta: number;
  bank_delta: number;
  reason: string;
}>(`SELECT id, user_id, ts, cash_delta, bank_delta, reason FROM balance_history ORDER BY ts ASC`);

for (const r of balRows.rows) {
  const tag = `[legacy-bal:${r.id}]`;
  const dupe = await db
    .select({ id: walletTransactions.id })
    .from(walletTransactions)
    .where(sql`${walletTransactions.memo} LIKE ${tag + "%"}`);
  if (dupe.length) continue;

  await db.insert(walletTransactions).values({
    characterId: null,
    userId: r.user_id,
    amount: r.cash_delta + r.bank_delta,
    kind: "historical",
    memo: `${tag} ${r.reason}`,
    createdAt: r.ts,
  });
  counts.ledger++;
}

// ---------- 6. STORES + STOCK ----------
const storeRows = await prod.query<{
  store_id: string;
  owner_id: string | null;
  store_name: string;
}>(`SELECT store_id, owner_id, store_name FROM wholesaler_stores WHERE owner_id IS NOT NULL`);
const storeMap = new Map<string, number>();
for (const r of storeRows.rows) {
  const tag = `[legacy-store:${r.store_id}]`;
  const found = await db
    .select({ id: stores.id })
    .from(stores)
    .where(sql`${stores.description} = ${tag}`);
  let id: number;
  if (found.length) {
    id = found[0].id;
  } else {
    const [ins] = await db
      .insert(stores)
      .values({
        ownerId: r.owner_id!,
        name: r.store_name,
        kind: "gun",
        description: tag,
        ownerCharacterId: ownerActiveChar.get(r.owner_id!) ?? null,
      })
      .returning({ id: stores.id });
    id = ins.id;
    counts.stores++;
  }
  storeMap.set(r.store_id, id);
}

const stockRows = await prod.query<{
  store_id: string;
  gun_name: string;
  gun_level: string;
  unit_cost: number;
  qty: number;
  weapon_type: string;
  gun_category: string;
}>(`SELECT store_id, gun_name, gun_level, unit_cost, qty, weapon_type, gun_category FROM store_inventory`);
for (const r of stockRows.rows) {
  const sid = storeMap.get(r.store_id);
  if (!sid) continue;
  // Upsert by store + name + level. We bake the level into the display name
  // so two different levels of the same gun don't collide on the (store,name)
  // pair, and so the level survives in the UI without a schema change.
  const displayName = `${r.gun_name} [${r.gun_level}]`;
  const found = await db
    .select({ id: storeStock.id })
    .from(storeStock)
    .where(and(eq(storeStock.storeId, sid), eq(storeStock.name, displayName)));
  if (found.length) {
    await db
      .update(storeStock)
      .set({ price: r.unit_cost, quantity: r.qty })
      .where(eq(storeStock.id, found[0].id));
  } else {
    await db.insert(storeStock).values({
      storeId: sid,
      name: displayName,
      category: r.gun_category,
      price: r.unit_cost,
      quantity: r.qty,
      notes: r.weapon_type,
    });
    counts.store_stock++;
  }
}

// ---------- 7. MISSIONS ----------
const missionRows = await prod.query<{
  mission_id: string;
  mission_name: string;
  mission_description: string;
  pay_per_player: string;
  start_ts: Date;
  paid: boolean;
  canceled: boolean;
  creator_id: string;
  attendee_ids: string[];
}>(`SELECT mission_id, mission_name, mission_description, pay_per_player, start_ts, paid, canceled, creator_id, attendee_ids FROM mission_event`);

for (const m of missionRows.rows) {
  for (const attendeeId of m.attendee_ids ?? []) {
    // Per-attendee tag so multiple attendees with null characterId are not
    // collapsed by a COALESCE(-1) dedupe bucket.
    const tag = `[legacy-mission:${m.mission_id}:${attendeeId}]`;
    const dupe = await db
      .select({ id: missionLog.id })
      .from(missionLog)
      .where(sql`${missionLog.summary} LIKE ${tag + "%"}`);
    if (dupe.length) continue;
    const charId = ownerActiveChar.get(attendeeId) ?? null;
    await db.insert(missionLog).values({
      characterId: charId,
      fixerId: m.creator_id,
      title: m.mission_name,
      summary: `${tag} ${m.mission_description ?? ""}`.trim(),
      payoutEddies: Number(m.pay_per_player),
      status: m.canceled ? "cancelled" : m.paid ? "completed_and_paid" : "completed",
      occurredAt: m.start_ts,
    });
    counts.missions++;
  }
}

// ---------- 8. BOT CONFIG ----------
const cfgRows = await prod.query<{ key: string; value: string }>(`SELECT key, value FROM bot_config`);
for (const r of cfgRows.rows) {
  let parsed: unknown = r.value;
  try { parsed = JSON.parse(r.value); } catch { /* keep as string */ }
  await db
    .insert(botConfig)
    .values({ key: r.key, value: parsed as object })
    .onConflictDoUpdate({ target: botConfig.key, set: { value: parsed as object } });
  counts.bot_config++;
}

await prod.end();
console.log("\nImport complete:");
console.table(counts);
