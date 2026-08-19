import { type IRouter, json as expressJson } from "express";
import { eq, desc, sql, and } from "drizzle-orm";
import {
  db, users, characters, walletTransactions,
  characterStatus, housing, catalogRent,
  characterUpdates, inventoryItems, inventoryEvents,
  storeEmployees, stores, ripperdocs, ripperdocEmployees,
  housingRequests, traumaTeamCalls, missionLog,
  customRequests, saleOffers, missionApplications, missionAssignments,
  pendingCharacterEdits, shopOpens, characterSheets, diceRolls,
  botActorAttendance, botAttendanceLog, botBalanceHistory, botCyberwareStatus,
  botCyberwareWeeklyRuns, botLastPayment, botPaymentLabels, botRentRuns,
  botStoreInventory, botTicketIndex, botMissionLog, botBusinessOpenLog,
  botPlayerInventory,
} from "@workspace/db";
import { isNull, count } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { fetchThreadOpMessage, imageAttachmentsOf, addGuildMemberRole, RIPPERDOC_ROLE_ID, RIPPERDOC_ROLE_MARKER, externalWritesAllowed, type ThreadAttachment } from "../../lib/discord";
import { ObjectStorageService } from "../../lib/objectStorage";
import { getBalance } from "../../lib/unbelievaboat";
import { recordAudit, recordAuditInline } from "../../lib/audit";
import { listMissionThreadBackfillTargets, runMissionThreadBackfill } from "../../lib/missionsService";
import { repairGuidebookLinks } from "../../lib/guidebookImport";
import { events } from "@workspace/db";
import { like } from "drizzle-orm";
import { rehostEventImage, guildEventImageUrl } from "../../lib/eventsService";
import {
  getEconomyMode,
  reconcileOneUser,
  applyWalletDelta,
  runUbBalanceRepair,
} from "../../lib/economy";
import { normalizeName } from "../../lib/strings";
import { adminOnly } from "./shared";

interface NpcExportRow {
  name: string;
  kind?: string;
  archetype?: string | null;
  lifeStatus?: string | null;
  approved?: boolean | null;
  claimed?: boolean | null;
  legacyDiscordUsername?: string | null;
  background?: string | null;
  portraitUrl?: string | null;
  portraitUrls?: string[] | null;
  statsImageUrls?: string[] | null;
  importedFromThreadId?: string | null;
  importedFromChannelName?: string | null;
  sheetData?: unknown;
}

// ---------------------------------------------------------------------------
// One-time dev->prod full migration. Imports characters (NPCs + PCs),
// character_status, housing leases, and catalog_rent in one shot. Idempotent:
// safe to re-run. Characters are matched by (kind, name); status/housing
// rows reference their character by (character_kind, character_name) instead
// of numeric id (serial ids differ between databases). catalog_rent is keyed
// on name. Admin-edited prod values for an existing character are preserved.
// ---------------------------------------------------------------------------
interface FullImportChar extends NpcExportRow {
  ownerId?: string | null;
  discordChannelId?: string | null;
  lifestyleTierId?: number | null;
  traumaTeamTier?: string | null;
  xanaduGold?: boolean | null;
  cyberwareLevel?: string | null;
  appliedTags?: string[] | null;
  archived?: boolean | null;
  // snake_case aliases (the export uses pg row_to_json naming)
  owner_id?: string | null;
  legacy_discord_username?: string | null;
  portrait_url?: string | null;
  portrait_urls?: string[] | null;
  stats_image_urls?: string[] | null;
  sheet_data?: unknown;
  imported_from_thread_id?: string | null;
  imported_from_channel_name?: string | null;
  discord_channel_id?: string | null;
  applied_tags?: string[] | null;
  life_status?: string | null;
  lifestyle_tier_id?: number | null;
  trauma_team_tier?: string | null;
  xanadu_gold?: boolean | null;
  cyberware_level?: string | null;
}
interface FullImportStatus {
  character_kind?: string;
  character_name?: string;
  loa?: boolean | null;
  loa_returns_at?: string | null;
  attending?: boolean | null;
  open_shop?: boolean | null;
  status_message?: string | null;
}
interface FullImportHousing {
  character_kind?: string;
  character_name?: string;
  address?: string;
  monthly_rent?: number | null;
  kind?: string | null;
  paid_through?: string | null;
  delinquent_since?: string | null;
  notes?: string | null;
}
interface FullImportRent {
  name?: string;
  district?: string | null;
  tier?: string | null;
  monthly_rent?: number | null;
  description?: string | null;
}
interface FullImportBody {
  characters?: FullImportChar[];
  character_status?: FullImportStatus[];
  housing?: FullImportHousing[];
  catalog_rent?: FullImportRent[];
}

// Pull the export's value preferring snake_case keys (from row_to_json dumps)
// then camelCase, then default. Lets the same endpoint accept either shape.
function pick<T>(
  obj: Record<string, unknown>,
  snake: string,
  camel: string,
  fallback: T,
): T {
  const s = obj[snake];
  if (s !== undefined && s !== null) return s as T;
  const c = obj[camel];
  if (c !== undefined && c !== null) return c as T;
  return fallback;
}

// ---------------------------------------------------------------------------
// Bot DB import. Mirrors 13 tables from the legacy Discord-bot Replit DB
// (rent/cyberware/transactions/attendance/...) into the `bot_*` tables.
// Idempotent: each table uses its natural dedup key (bot_id where present,
// composite unique elsewhere). Big payloads inserted in 500-row chunks.
//   Body shape: { tables: { actor_attendance: [...], ... } }
// ---------------------------------------------------------------------------
interface BotImportBody {
  tables?: Record<string, Array<Record<string, unknown>>>;
}

// Insert rows in chunks so very large payloads (2,672 tickets, 1,777
// attendance rows) don't blow past pg's per-statement parameter limit.
// Uses RETURNING (any column) so `inserted` is the TRUE number of new rows —
// onConflictDoNothing skips don't show up in returning, so rerun counts go
// to zero. `chunkFailures` records full-chunk errors separately so the UI
// doesn't conflate a 500-row chunk crash with per-row failures.
async function chunkedInsert<T extends PgTable>(
  table: T,
  rows: Array<Record<string, unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  conflict: (q: any) => any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  returningCol: any,
): Promise<{ received: number; inserted: number; chunkFailures: number; lastError?: string }> {
  let inserted = 0;
  let chunkFailures = 0;
  let lastError: string | undefined;
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const q = (db.insert(table) as any).values(slice);
      const ret = await conflict(q).returning({ k: returningCol });
      inserted += Array.isArray(ret) ? ret.length : 0;
    } catch (e) {
      chunkFailures += 1;
      lastError = (e as Error).message;
    }
  }
  return { received: rows.length, inserted, chunkFailures, lastError };
}

function parseTs(v: unknown): Date | null {
  if (!v) return null;
  if (typeof v === "string" || typeof v === "number") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}
function asInt(v: unknown, dflt = 0): number {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return Math.trunc(n);
  }
  return dflt;
}
function asStr(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v;
  return String(v);
}
function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function normalizeNameForDupes(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[\u2018\u2019\u201c\u201d]/g, "'") // smart quotes -> '
    .replace(/\s*\((?:npc|pc)\)\s*$/i, "")      // trailing kind tag
    .replace(/\s+/g, " ")
    .trim();
}

function pickSuggestedKeep<T extends {
  id: number;
  hasSheetData: boolean;
  portraitUrl: string | null;
  ownerId: string | null;
  createdAt: Date | string;
}>(list: T[]): number {
  const score = (r: T) =>
    (r.hasSheetData ? 8 : 0) +
    (r.portraitUrl ? 4 : 0) +
    (r.ownerId ? 2 : 0);
  let best = list[0];
  for (const r of list) {
    const sb = score(best);
    const sr = score(r);
    if (sr > sb) best = r;
    else if (sr === sb && new Date(r.createdAt) < new Date(best.createdAt)) best = r;
  }
  return best.id;
}

// [table, column] for user-id references that can be repointed with a plain
// UPDATE — there is no UNIQUE/PK on the column so two rows for the same user
// never collide. DB (snake_case) names; driven through a raw UPDATE so we don't
// have to import ~50 table objects.
const ACCOUNT_PLAIN_USER_COLS: ReadonlyArray<readonly [string, string]> = [
  ["characters", "owner_id"],
  ["character_updates", "author_id"],
  ["inventory_items", "owner_id"],
  ["wallet_transactions", "user_id"],
  ["stores", "owner_id"],
  ["ripperdocs", "owner_id"],
  ["fixer_npcs", "fixer_id"],
  ["character_sheets", "owner_id"],
  ["character_sheets", "overridden_by"],
  ["character_sheets", "closed_by"],
  ["dice_rolls", "user_id"],
  ["catalog_districts", "created_by_id"],
  ["character_tag_options", "created_by_id"],
  ["housing_requests", "requested_by_id"],
  ["housing_requests", "reviewed_by_id"],
  ["custom_requests", "requested_by_id"],
  ["custom_requests", "reviewed_by_id"],
  ["custom_requests", "overridden_by"],
  ["custom_requests", "closed_by"],
  ["sale_offers", "buyer_user_id"],
  ["sale_offers", "created_by_id"],
  ["mission_log", "fixer_id"],
  ["missions", "fixer_id"],
  ["missions", "completed_by"],
  ["mission_applications", "user_id"],
  ["mission_applications", "reviewed_by"],
  ["events", "created_by_id"],
  ["wholesaler_orders", "fixer_id"],
  ["pending_character_edits", "submitted_by"],
  ["pending_character_edits", "overridden_by"],
  ["pending_character_edits", "closed_by"],
  ["review_comments", "author_id"],
  ["lore_entries", "created_by_id"],
  ["lore_entries", "updated_by_id"],
  ["lore_pending_edits", "submitted_by"],
  ["lore_pending_edits", "decided_by_id"],
  ["lore_pending_edits", "overridden_by"],
  ["lore_pending_edits", "closed_by"],
  ["lore_import_drafts", "decided_by_id"],
  ["guidebook_pages", "created_by_id"],
  ["guidebook_pages", "updated_by_id"],
  ["guidebook_pending_edits", "submitted_by"],
  ["guidebook_pending_edits", "decided_by_id"],
  ["breach_puzzles", "created_by"],
  ["breach_puzzles", "assigned_user_id"],
  ["breach_practice_clears", "user_id"],
  ["vrchat_agent_commands", "user_id"],
  ["vrchat_agent_commands", "created_by_id"],
];

function summarizeUserForMerge(u: typeof users.$inferSelect): Record<string, unknown> {
  return {
    id: u.id,
    username: u.username,
    globalName: u.globalName,
    roles: u.roles,
    walletBalance: u.walletBalance,
    lastSyncedUbBalance: u.lastSyncedUbBalance,
    defaultAvailability: u.defaultAvailability != null,
    availabilityTimezone: u.availabilityTimezone,
    createdAt: u.createdAt,
    lastSeenAt: u.lastSeenAt,
  };
}

// A curated set of ownership/meaningful child counts for the dry-run preview.
// The actual merge repoints EVERY user-id column, not only these.
async function collectAccountChildCounts(userId: string): Promise<Record<string, number>> {
  const c = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  return {
    characters: await c(db.select({ n: count() }).from(characters).where(eq(characters.ownerId, userId))),
    stores: await c(db.select({ n: count() }).from(stores).where(eq(stores.ownerId, userId))),
    ripperdocs: await c(db.select({ n: count() }).from(ripperdocs).where(eq(ripperdocs.ownerId, userId))),
    character_sheets: await c(db.select({ n: count() }).from(characterSheets).where(eq(characterSheets.ownerId, userId))),
    inventory_items: await c(db.select({ n: count() }).from(inventoryItems).where(eq(inventoryItems.ownerId, userId))),
    wallet_transactions: await c(db.select({ n: count() }).from(walletTransactions).where(eq(walletTransactions.userId, userId))),
    custom_requests: await c(db.select({ n: count() }).from(customRequests).where(eq(customRequests.requestedById, userId))),
    housing_requests: await c(db.select({ n: count() }).from(housingRequests).where(eq(housingRequests.requestedById, userId))),
    mission_assignments: await c(db.select({ n: count() }).from(missionAssignments).where(eq(missionAssignments.userId, userId))),
    mission_applications: await c(db.select({ n: count() }).from(missionApplications).where(eq(missionApplications.userId, userId))),
    sale_offers_as_buyer: await c(db.select({ n: count() }).from(saleOffers).where(eq(saleOffers.buyerUserId, userId))),
  };
}

function summarizeForMerge(c: typeof characters.$inferSelect): Record<string, unknown> {
  return {
    id: c.id,
    name: c.name,
    kind: c.kind,
    ownerId: c.ownerId,
    archetype: c.archetype,
    portraitUrl: c.portraitUrl,
    portraitCount: c.portraitUrls?.length ?? 0,
    hasSheetData: c.sheetData != null,
    importedFromThreadId: c.importedFromThreadId,
    legacyDiscordUsername: c.legacyDiscordUsername,
    approved: c.approved,
    archived: c.archived,
    lifeStatus: c.lifeStatus,
    createdAt: c.createdAt,
  };
}

function diffFieldsForFill(keep: typeof characters.$inferSelect, drop: typeof characters.$inferSelect): string[] {
  const fields: string[] = [];
  if (!keep.archetype && drop.archetype) fields.push("archetype");
  if (!keep.background && drop.background) fields.push("background");
  if (!keep.portraitUrl && drop.portraitUrl) fields.push("portraitUrl");
  if ((keep.portraitUrls?.length ?? 0) === 0 && (drop.portraitUrls?.length ?? 0) > 0) fields.push("portraitUrls");
  if ((keep.statsImageUrls?.length ?? 0) === 0 && (drop.statsImageUrls?.length ?? 0) > 0) fields.push("statsImageUrls");
  if (!keep.sheetData && drop.sheetData) fields.push("sheetData");
  if (!keep.importedFromThreadId && drop.importedFromThreadId) fields.push("importedFromThreadId");
  if (!keep.importedFromChannelName && drop.importedFromChannelName) fields.push("importedFromChannelName");
  if ((keep.appliedTags?.length ?? 0) === 0 && (drop.appliedTags?.length ?? 0) > 0) fields.push("appliedTags");
  if (!keep.legacyDiscordUsername && drop.legacyDiscordUsername) fields.push("legacyDiscordUsername");
  if (!keep.ownerId && drop.ownerId) fields.push("ownerId");
  if (!keep.discordChannelId && drop.discordChannelId) fields.push("discordChannelId");
  return fields;
}

async function collectChildCounts(charId: number): Promise<Record<string, number>> {
  const c = async (q: Promise<Array<{ n: number }>>) => (await q)[0]?.n ?? 0;
  return {
    character_updates: await c(db.select({ n: count() }).from(characterUpdates).where(eq(characterUpdates.characterId, charId))),
    inventory_items: await c(db.select({ n: count() }).from(inventoryItems).where(eq(inventoryItems.characterId, charId))),
    store_employees: await c(db.select({ n: count() }).from(storeEmployees).where(eq(storeEmployees.characterId, charId))),
    ripperdoc_employees: await c(db.select({ n: count() }).from(ripperdocEmployees).where(eq(ripperdocEmployees.characterId, charId))),
    housing: await c(db.select({ n: count() }).from(housing).where(eq(housing.characterId, charId))),
    housing_requests: await c(db.select({ n: count() }).from(housingRequests).where(eq(housingRequests.characterId, charId))),
    trauma_team_calls: await c(db.select({ n: count() }).from(traumaTeamCalls).where(eq(traumaTeamCalls.characterId, charId))),
    mission_log: await c(db.select({ n: count() }).from(missionLog).where(eq(missionLog.characterId, charId))),
    wallet_transactions: await c(db.select({ n: count() }).from(walletTransactions).where(eq(walletTransactions.characterId, charId))),
    character_sheets: await c(db.select({ n: count() }).from(characterSheets).where(eq(characterSheets.characterId, charId))),
    shop_opens: await c(db.select({ n: count() }).from(shopOpens).where(eq(shopOpens.characterId, charId))),
    pending_edits: await c(db.select({ n: count() }).from(pendingCharacterEdits).where(eq(pendingCharacterEdits.characterId, charId))),
    custom_requests: await c(db.select({ n: count() }).from(customRequests).where(eq(customRequests.characterId, charId))),
    sale_offers: await c(db.select({ n: count() }).from(saleOffers).where(eq(saleOffers.buyerCharacterId, charId))),
    mission_assignments: await c(db.select({ n: count() }).from(missionAssignments).where(eq(missionAssignments.characterId, charId))),
    mission_applications: await c(db.select({ n: count() }).from(missionApplications).where(eq(missionApplications.characterId, charId))),
  };
}

async function previewClaimByUsername(): Promise<Array<{
  characterId: number;
  characterName: string;
  kind: string;
  legacyDiscordUsername: string;
  matchedUserIds: string[];
  matchedUsernames: string[];
}>> {
  const unclaimed = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      legacyDiscordUsername: characters.legacyDiscordUsername,
    })
    .from(characters)
    .where(and(
      isNull(characters.ownerId),
      sql`${characters.legacyDiscordUsername} is not null`,
      sql`length(trim(${characters.legacyDiscordUsername})) > 0`,
    ));

  if (unclaimed.length === 0) return [];

  // One pass over `users` keyed by lower-cased username for an in-memory
  // join — the user table is small (every logged-in member, hundreds at
  // most) and the row count squared is dwarfed by network roundtrips if
  // we did it per-character.
  const allUsers = await db.select({ id: users.id, username: users.username, globalName: users.globalName }).from(users);
  const byUsername = new Map<string, Array<{ id: string; username: string }>>();
  for (const u of allUsers) {
    for (const handle of [u.username, u.globalName].filter((x): x is string => !!x)) {
      const key = normalizeName(handle);
      if (!key) continue;
      const list = byUsername.get(key) ?? [];
      list.push({ id: u.id, username: u.username });
      byUsername.set(key, list);
    }
  }

  return unclaimed.map((c) => {
    const key = normalizeName(c.legacyDiscordUsername ?? "");
    const hits = byUsername.get(key) ?? [];
    // Dedupe — a single user matched on both username AND globalName
    // shouldn't be counted twice.
    const uniq = new Map<string, string>();
    for (const h of hits) uniq.set(h.id, h.username);
    return {
      characterId: c.id,
      characterName: c.name,
      kind: c.kind,
      legacyDiscordUsername: c.legacyDiscordUsername ?? "",
      matchedUserIds: Array.from(uniq.keys()),
      matchedUsernames: Array.from(uniq.values()),
    };
  });
}

// ---------------------------------------------------------------------------
// Portrait backfill from Discord. Many NPCs (and a long tail of PCs) were
// imported with an `imported_from_thread_id` but no portrait, because the
// original importer only scraped sheet *text* and skipped attachments.
// The OP message of a #character-sheets forum post is almost always the
// portrait image the player posted, so we can recover them after the fact:
//   PREVIEW  → list characters missing a portrait whose thread we can hit,
//              with the attachment filenames Discord still has for them.
//   APPLY    → for each selected character, download the first image
//              attachment, re-host it on object storage, and save it as
//              the primary portrait (also appended to portrait_urls so the
//              gallery picks it up).
// We rehost rather than store cdn.discordapp.com URLs because those URLs
// are signed and expire after ~24h — saving them directly would surface
// broken images within a day.
// ---------------------------------------------------------------------------

interface BackfillCandidate {
  characterId: number;
  characterName: string;
  kind: string;
  threadId: string;
  attachmentCount: number;
  firstAttachment: { filename: string; contentType: string | null; width: number | null; height: number | null } | null;
  reason: string | null; // populated when fetch fails (404, no perms, etc.)
}

async function listPortraitBackfillCandidates(): Promise<BackfillCandidate[]> {
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      kind: characters.kind,
      threadId: characters.importedFromThreadId,
    })
    .from(characters)
    .where(
      and(
        eq(characters.archived, false),
        isNull(characters.portraitUrl),
        sql`coalesce(array_length(${characters.portraitUrls}, 1), 0) = 0`,
        sql`${characters.importedFromThreadId} is not null`,
      ),
    )
    .orderBy(characters.kind, characters.name);

  // Sequential fetch — Discord rate-limits aggressively (per-route bucket
  // ~5 req/s) and a typical run is dozens, not thousands. Going parallel
  // would just trip the limiter and slow the whole thing down.
  const out: BackfillCandidate[] = [];
  for (const r of rows) {
    if (!r.threadId) continue;
    let attachments: ThreadAttachment[] = [];
    let reason: string | null = null;
    try {
      const msg = await fetchThreadOpMessage(r.threadId);
      if (!msg) {
        reason = "thread inaccessible (deleted, archived w/o perms, or bot kicked)";
      } else {
        attachments = imageAttachmentsOf(msg);
        if (attachments.length === 0) reason = "OP has no image attachments";
      }
    } catch (err) {
      reason = `fetch error: ${(err as Error).message}`;
    }
    out.push({
      characterId: r.id,
      characterName: r.name,
      kind: r.kind,
      threadId: r.threadId,
      attachmentCount: attachments.length,
      firstAttachment: attachments[0]
        ? {
          filename: attachments[0].filename,
          contentType: attachments[0].contentType,
          width: attachments[0].width,
          height: attachments[0].height,
        }
        : null,
      reason,
    });
  }
  return out;
}

export function registerMaintenance(router: IRouter): void {
  // ─── NPC maintenance: dev → prod data sync ────────────────────────────────
  // Production DB writes go through the running app (Replit's executeSql is
  // read-only against prod, and migration scripts aren't allowed). Dev → prod
  // data sync therefore uses an export/import pair:
  //   1) Admin in dev calls GET /admin/maintenance/npc-export → JSON dump.
  //   2) Admin in prod calls POST /admin/maintenance/npc-import with that JSON.
  // Idempotent upsert keyed on (kind='npc', name). Admin-assigned ownerId is
  // preserved on rerun via COALESCE so this is safe to import multiple times.
  // Portrait URLs continue to resolve in prod because dev and prod share the
  // same DEFAULT_OBJECT_STORAGE_BUCKET_ID.
  router.get("/admin/maintenance/npc-export", adminOnly, async (_req, res): Promise<void> => {
    const rows = await db
      .select()
      .from(characters)
      .where(eq(characters.kind, "npc"))
      .orderBy(characters.name);
    res.setHeader("content-disposition", `attachment; filename="ncrp-npcs-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({
      exportedAt: new Date().toISOString(),
      count: rows.length,
      npcs: rows.map((r) => ({
        name: r.name,
        kind: r.kind,
        archetype: r.archetype,
        lifeStatus: r.lifeStatus,
        approved: r.approved,
        claimed: r.claimed,
        legacyDiscordUsername: r.legacyDiscordUsername,
        background: r.background,
        portraitUrl: r.portraitUrl,
        portraitUrls: r.portraitUrls,
        statsImageUrls: r.statsImageUrls,
        importedFromThreadId: r.importedFromThreadId,
        importedFromChannelName: r.importedFromChannelName,
        sheetData: r.sheetData,
        // ownerId intentionally OMITTED — owner assignments are environment-
        // local (a dev test owner won't exist in prod). Prod assignments must
        // be made via the existing /admin/characters/:id/owner endpoint.
      })),
    });
  });

  router.post(
    "/admin/maintenance/npc-import",
    adminOnly,
    expressJson({ limit: "20mb" }),
    async (req, res): Promise<void> => {
      const body = req.body as { npcs?: NpcExportRow[] } | null;
      if (!body || !Array.isArray(body.npcs)) {
        res.status(400).json({ error: "Body must be { npcs: [...] }" });
        return;
      }
      let inserted = 0;
      let updated = 0;
      let skipped = 0;
      const errors: Array<{ name: string; error: string }> = [];

      for (const npc of body.npcs) {
        if (!npc || typeof npc.name !== "string" || !npc.name.trim()) {
          skipped++;
          continue;
        }
        try {
          // Match the dev-to-prod character resolver: imported_from_thread_id
          // is the actual UNIQUE key on `characters`. If we look up only by
          // (kind,name) and the name has drifted (smart quotes, retitle),
          // we'll try to re-insert and either 500 on the unique index, or
          // (if the NPC arrived via a different code path with NULL
          // thread_id) silently create a half-populated duplicate.
          let existing: Array<{ id: number }> = [];
          if (npc.importedFromThreadId) {
            existing = await db
              .select({ id: characters.id })
              .from(characters)
              .where(eq(characters.importedFromThreadId, npc.importedFromThreadId))
              .limit(1);
          }
          if (existing.length === 0) {
            existing = await db
              .select({ id: characters.id })
              .from(characters)
              .where(and(eq(characters.kind, "npc"), eq(characters.name, npc.name)))
              .limit(1);
          }
          if (existing.length === 0) {
            await db.insert(characters).values({
              name: npc.name,
              kind: "npc",
              ownerId: null,
              archetype: npc.archetype ?? null,
              lifeStatus: npc.lifeStatus ?? "active",
              approved: npc.approved ?? true,
              claimed: npc.claimed ?? false,
              legacyDiscordUsername: npc.legacyDiscordUsername ?? null,
              background: npc.background ?? null,
              portraitUrl: npc.portraitUrl ?? null,
              portraitUrls: npc.portraitUrls ?? [],
              statsImageUrls: npc.statsImageUrls ?? [],
              importedFromThreadId: npc.importedFromThreadId ?? null,
              importedFromChannelName: npc.importedFromChannelName ?? null,
              sheetData: (npc.sheetData ?? null) as never,
            });
            inserted++;
          } else {
            // Preserve admin-assigned ownerId (never touched here). For other
            // fields, an explicit value in the export wins; otherwise keep what
            // prod already has, so admins editing in prod don't get clobbered.
            // approved/claimed are preserve-first too (previously they were always
            // overwritten with ?? true / ?? false, clobbering prod admin decisions
            // whenever the export omitted them).
            const updateSet: Record<string, unknown> = {};
            if (npc.approved != null) updateSet.approved = npc.approved;
            if (npc.claimed != null) updateSet.claimed = npc.claimed;
            if (npc.archetype != null) updateSet.archetype = npc.archetype;
            if (npc.lifeStatus != null) updateSet.lifeStatus = npc.lifeStatus;
            if (npc.legacyDiscordUsername != null) updateSet.legacyDiscordUsername = npc.legacyDiscordUsername;
            if (npc.background != null) updateSet.background = npc.background;
            if (npc.portraitUrl != null) updateSet.portraitUrl = npc.portraitUrl;
            if (Array.isArray(npc.portraitUrls) && npc.portraitUrls.length > 0) updateSet.portraitUrls = npc.portraitUrls;
            if (Array.isArray(npc.statsImageUrls) && npc.statsImageUrls.length > 0) updateSet.statsImageUrls = npc.statsImageUrls;
            if (npc.importedFromThreadId != null) updateSet.importedFromThreadId = npc.importedFromThreadId;
            if (npc.importedFromChannelName != null) updateSet.importedFromChannelName = npc.importedFromChannelName;
            if (npc.sheetData != null) updateSet.sheetData = npc.sheetData as never;
            if (Object.keys(updateSet).length > 0) {
              await db.update(characters).set(updateSet).where(eq(characters.id, existing[0].id));
            }
            updated++;
          }
        } catch (err) {
          errors.push({ name: npc.name, error: (err as Error).message });
        }
      }

      await recordAudit({
        req,
        category: "admin",
        action: "npc_import",
        message: `NPC import: ${inserted} inserted, ${updated} updated, ${skipped} skipped, ${errors.length} errors`,
        after: { inserted, updated, skipped, errors: errors.length },
      });
      res.json({ inserted, updated, skipped, errors });
    },
  );

  router.post(
    "/admin/maintenance/full-import",
    adminOnly,
    expressJson({ limit: "50mb" }),
    async (req, res): Promise<void> => {
      const body = req.body as FullImportBody | null;
      if (!body || typeof body !== "object") {
        res.status(400).json({ error: "Body must be JSON object" });
        return;
      }
      const result = {
        characters: { inserted: 0, updated: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
        character_status: { inserted: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
        housing: { inserted: 0, skipped: 0, errors: [] as Array<{ address: string; error: string }> },
        catalog_rent: { inserted: 0, skipped: 0, errors: [] as Array<{ name: string; error: string }> },
      };

      // ---- 1) catalog_rent (insert by name if missing) -----------------------
      for (const r of body.catalog_rent ?? []) {
        const name = r.name?.trim();
        if (!name) { result.catalog_rent.skipped++; continue; }
        try {
          const existing = await db
            .select({ id: catalogRent.id })
            .from(catalogRent)
            .where(eq(catalogRent.name, name))
            .limit(1);
          if (existing.length === 0) {
            await db.insert(catalogRent).values({
              name,
              district: r.district ?? null,
              tier: r.tier ?? null,
              monthlyRent: r.monthly_rent ?? 0,
              description: r.description ?? null,
            });
            result.catalog_rent.inserted++;
          } else {
            result.catalog_rent.skipped++;
          }
        } catch (err) {
          result.catalog_rent.errors.push({ name, error: (err as Error).message });
        }
      }

      // Track every dev row → prod id we resolve in this pass, keyed by the
      // DEV-side `${kind}|${name.toLowerCase()}`. Downstream loops (status,
      // housing, …) look up by dev name; without this map, any case where
      // prod's stored name differs from dev's (smart quotes, retitle) would
      // cascade as "character not found in prod" even though the row was
      // successfully resolved by imported_from_thread_id above.
      const idByDevName = new Map<string, number>();

      // ---- 2) characters (upsert by imported_from_thread_id first, then kind+name)
      // Why thread-id first: `characters_imported_thread_idx` is a UNIQUE index
      // on imported_from_thread_id. Prod may already have a row imported via
      // the normal Discord-thread workflow under a slightly different name
      // (smart quotes, whitespace, post-import retitle). Looking up by
      // (kind,name) misses, we try to insert, and the unique index 500s the
      // row — then every downstream (character_status, housing, …) cascades
      // as "character not found in prod". Resolving by thread-id first makes
      // the importer truly idempotent against the actual unique key.
      for (const raw of body.characters ?? []) {
        const r = raw as unknown as Record<string, unknown>;
        const name = (raw.name as string | undefined)?.trim();
        const kind = (raw.kind as string | undefined) ?? "npc";
        const threadId = pick<string | null>(r, "imported_from_thread_id", "importedFromThreadId", null);
        if (!name) { result.characters.skipped++; continue; }
        try {
          let existing: Array<{ id: number }> = [];
          if (threadId) {
            existing = await db
              .select({ id: characters.id })
              .from(characters)
              .where(eq(characters.importedFromThreadId, threadId))
              .limit(1);
          }
          if (existing.length === 0) {
            existing = await db
              .select({ id: characters.id })
              .from(characters)
              .where(and(eq(characters.kind, kind), eq(characters.name, name)))
              .limit(1);
          }
          const values = {
            name,
            kind,
            ownerId: pick<string | null>(r, "owner_id", "ownerId", null),
            archetype: pick<string | null>(r, "archetype", "archetype", null),
            background: pick<string | null>(r, "background", "background", null),
            portraitUrl: pick<string | null>(r, "portrait_url", "portraitUrl", null),
            discordChannelId: pick<string | null>(r, "discord_channel_id", "discordChannelId", null),
            approved: pick<boolean>(r, "approved", "approved", true),
            claimed: pick<boolean>(r, "claimed", "claimed", false),
            legacyDiscordUsername: pick<string | null>(r, "legacy_discord_username", "legacyDiscordUsername", null),
            portraitUrls: pick<string[]>(r, "portrait_urls", "portraitUrls", []),
            statsImageUrls: pick<string[]>(r, "stats_image_urls", "statsImageUrls", []),
            sheetData: pick<unknown>(r, "sheet_data", "sheetData", null) as never,
            importedFromThreadId: pick<string | null>(r, "imported_from_thread_id", "importedFromThreadId", null),
            importedFromChannelName: pick<string | null>(r, "imported_from_channel_name", "importedFromChannelName", null),
            appliedTags: pick<string[]>(r, "applied_tags", "appliedTags", []),
            lifeStatus: pick<string>(r, "life_status", "lifeStatus", "active"),
            lifestyleTierId: pick<number | null>(r, "lifestyle_tier_id", "lifestyleTierId", null),
            traumaTeamTier: pick<string | null>(r, "trauma_team_tier", "traumaTeamTier", null),
            xanaduGold: pick<boolean>(r, "xanadu_gold", "xanaduGold", false),
            cyberwareLevel: pick<string>(r, "cyberware_level", "cyberwareLevel", "none"),
            archived: pick<boolean>(r, "archived", "archived", false),
          };
          if (existing.length === 0) {
            // Owner FK safety: only carry ownerId across if that Discord user
            // already exists in prod (users.id IS the Discord snowflake — global,
            // so it CAN match — but a PC's owner may not have logged into prod
            // yet, in which case the FK would 500 the whole row). Drop to null
            // and let the existing claim/assign flow attach the owner later.
            let safeOwnerId: string | null = null;
            if (values.ownerId) {
              const u = await db.select({ id: users.id }).from(users).where(eq(users.id, values.ownerId)).limit(1);
              if (u.length > 0) safeOwnerId = values.ownerId;
            }
            const ins = await db.insert(characters).values({ ...values, ownerId: safeOwnerId }).returning({ id: characters.id });
            if (ins[0]) idByDevName.set(`${kind}|${name.toLowerCase()}`, ins[0].id);
            result.characters.inserted++;
          } else {
            idByDevName.set(`${kind}|${name.toLowerCase()}`, existing[0].id);
            // PRESERVE-FIRST: never overwrite prod-side state on rerun. This
            // endpoint is a one-shot importer — admin edits made in prod after
            // the first import are sacred. We only fill *missing/empty* fields
            // (so a row imported headless can later get sheet/portrait data
            // backfilled), and we never touch ownerId, approved, claimed,
            // archived, lifeStatus, xanaduGold, lifestyleTierId — those are
            // admin-managed in prod.
            //   Memory: importer-upsert-idempotency, nullable-owner-guards.
            const prod = await db
              .select()
              .from(characters)
              .where(eq(characters.id, existing[0].id))
              .limit(1);
            const cur = prod[0];
            const updateSet: Record<string, unknown> = {};
            const fillIfEmpty = (k: keyof typeof cur, v: unknown) => {
              const curVal = cur[k];
              const isEmpty =
                curVal == null ||
                (typeof curVal === "string" && curVal.trim() === "") ||
                (Array.isArray(curVal) && curVal.length === 0);
              if (isEmpty && v != null && !(Array.isArray(v) && v.length === 0)) {
                updateSet[k] = v;
              }
            };
            fillIfEmpty("archetype", values.archetype);
            fillIfEmpty("background", values.background);
            fillIfEmpty("portraitUrl", values.portraitUrl);
            fillIfEmpty("discordChannelId", values.discordChannelId);
            fillIfEmpty("legacyDiscordUsername", values.legacyDiscordUsername);
            fillIfEmpty("portraitUrls", values.portraitUrls);
            fillIfEmpty("statsImageUrls", values.statsImageUrls);
            fillIfEmpty("appliedTags", values.appliedTags);
            fillIfEmpty("sheetData", values.sheetData);
            fillIfEmpty("importedFromThreadId", values.importedFromThreadId);
            fillIfEmpty("importedFromChannelName", values.importedFromChannelName);
            fillIfEmpty("traumaTeamTier", values.traumaTeamTier);
            fillIfEmpty("cyberwareLevel", values.cyberwareLevel === "none" ? null : values.cyberwareLevel);
            if (Object.keys(updateSet).length > 0) {
              await db.update(characters).set(updateSet).where(eq(characters.id, existing[0].id));
              result.characters.updated++;
            } else {
              result.characters.skipped++;
            }
          }
        } catch (err) {
          result.characters.errors.push({ name: name ?? "(unknown)", error: (err as Error).message });
        }
      }

      // Build prod-side (kind|name) -> id map for the linked tables. The
      // dev-name map above takes priority — it covers rows resolved via
      // imported_from_thread_id where prod's stored name differs from dev's.
      const allRows = await db
        .select({ id: characters.id, kind: characters.kind, name: characters.name })
        .from(characters);
      const idByName = new Map<string, number>();
      for (const r of allRows) idByName.set(`${r.kind}|${r.name.toLowerCase()}`, r.id);
      const lookup = (kind?: string, name?: string): number | undefined => {
        if (!kind || !name) return undefined;
        const key = `${kind}|${name.toLowerCase()}`;
        return idByDevName.get(key) ?? idByName.get(key);
      };

      // ---- 3) character_status (upsert by character_id) ----------------------
      for (const s of body.character_status ?? []) {
        const cid = lookup(s.character_kind, s.character_name);
        if (!cid) {
          result.character_status.skipped++;
          result.character_status.errors.push({ name: `${s.character_kind}/${s.character_name}`, error: "character not found in prod" });
          continue;
        }
        try {
          const existing = await db
            .select({ characterId: characterStatus.characterId })
            .from(characterStatus)
            .where(eq(characterStatus.characterId, cid))
            .limit(1);
          if (existing.length === 0) {
            await db.insert(characterStatus).values({
              characterId: cid,
              loa: s.loa ?? false,
              loaReturnsAt: s.loa_returns_at ? new Date(s.loa_returns_at) : null,
              attending: s.attending ?? false,
              openShop: s.open_shop ?? false,
              statusMessage: s.status_message ?? null,
            });
            result.character_status.inserted++;
          } else {
            result.character_status.skipped++;
          }
        } catch (err) {
          result.character_status.errors.push({ name: `${s.character_kind}/${s.character_name}`, error: (err as Error).message });
        }
      }

      // ---- 4) housing (insert; key uniqueness = char+address) ----------------
      for (const h of body.housing ?? []) {
        const cid = lookup(h.character_kind, h.character_name);
        const addr = h.address?.trim();
        if (!cid || !addr) {
          result.housing.skipped++;
          if (addr) result.housing.errors.push({ address: addr, error: cid ? "missing address" : "character not found in prod" });
          continue;
        }
        try {
          // Idempotent: skip if this character already has a lease at that address.
          const existing = await db
            .select({ id: housing.id })
            .from(housing)
            .where(and(eq(housing.characterId, cid), eq(housing.address, addr)))
            .limit(1);
          if (existing.length > 0) { result.housing.skipped++; continue; }
          await db.insert(housing).values({
            characterId: cid,
            address: addr,
            monthlyRent: h.monthly_rent ?? 0,
            kind: h.kind ?? "residential",
            paidThrough: h.paid_through ? new Date(h.paid_through) : null,
            delinquentSince: h.delinquent_since ? new Date(h.delinquent_since) : null,
            notes: h.notes ?? null,
          });
          result.housing.inserted++;
        } catch (err) {
          result.housing.errors.push({ address: addr, error: (err as Error).message });
        }
      }

      await recordAudit({
        req,
        category: "admin",
        action: "full_import",
        message: `Full migration import: chars +${result.characters.inserted}/~${result.characters.updated}, status +${result.character_status.inserted}, housing +${result.housing.inserted}, rent +${result.catalog_rent.inserted}`,
        after: {
          characters: { inserted: result.characters.inserted, updated: result.characters.updated, errors: result.characters.errors.length },
          character_status: { inserted: result.character_status.inserted, errors: result.character_status.errors.length },
          housing: { inserted: result.housing.inserted, errors: result.housing.errors.length },
          catalog_rent: { inserted: result.catalog_rent.inserted, errors: result.catalog_rent.errors.length },
        },
      });
      res.json(result);
    },
  );

  router.post(
    "/admin/maintenance/bot-import",
    adminOnly,
    expressJson({ limit: "50mb" }),
    async (req, res): Promise<void> => {
      const body = req.body as BotImportBody | null;
      if (!body?.tables || typeof body.tables !== "object") {
        res.status(400).json({ error: "Body must be { tables: { ... } }" });
        return;
      }
      const t = body.tables;
      // Validate every present table value is actually an array — protects
      // against malformed uploads (object/string/null) that would otherwise
      // 500 inside the .map() call below.
      for (const [k, v] of Object.entries(t)) {
        if (!Array.isArray(v)) {
          res.status(400).json({ error: `tables.${k} must be an array, got ${typeof v}` });
          return;
        }
      }

      type TableResult = { received: number; inserted: number; skippedInvalid: number; chunkFailures: number; note?: string };
      const out: Record<string, TableResult> = {};
      const skip = (name: string) => { out[name] = { received: 0, inserted: 0, skippedInvalid: 0, chunkFailures: 0, note: "not present in upload" }; };

      // Helper: take a mapped + filtered list and return both the kept rows
      // and the count of input rows that were dropped (missing required dedup
      // fields). Strict idempotency rule: rows missing a dedup key are SKIPPED,
      // never inserted with a fabricated value — fabrication breaks rerun.
      function split<R>(input: unknown[], map: (r: Record<string, unknown>) => R | null): { rows: R[]; skippedInvalid: number } {
        const rows: R[] = [];
        let skippedInvalid = 0;
        for (const raw of input) {
          const r = map(raw as Record<string, unknown>);
          if (r == null) skippedInvalid++; else rows.push(r);
        }
        return { rows, skippedInvalid };
      }

      // 1) actor_attendance — dedup by bot_id (must be present)
      if (t.actor_attendance) {
        const { rows, skippedInvalid } = split(t.actor_attendance, (r) => {
          const botId = asInt(r.bot_id, 0); if (!botId) return null;
          const userId = asStr(r.user_id); if (!userId) return null;
          const actedAt = parseTs(r.acted_at); if (!actedAt) return null;
          return {
            botId, userId, username: asStr(r.username),
            missionId: asStr(r.mission_id), missionName: asStr(r.mission_name),
            fixerId: asStr(r.fixer_id), fixerUsername: asStr(r.fixer_username),
            payAmount: asInt(r.pay_amount, 0), actedAt,
          };
        });
        const res = await chunkedInsert(botActorAttendance, rows, (q) => q.onConflictDoNothing({ target: botActorAttendance.botId }), botActorAttendance.id);
        out.actor_attendance = { received: t.actor_attendance.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("actor_attendance");

      // 2) attendance_log — dedup by (user, ts); skip if ts missing
      if (t.attendance_log) {
        const { rows, skippedInvalid } = split(t.attendance_log, (r) => {
          const userId = asStr(r.user_id); const loggedAt = parseTs(r.logged_at);
          if (!userId || !loggedAt) return null;
          return { userId, loggedAt };
        });
        const res = await chunkedInsert(botAttendanceLog, rows, (q) => q.onConflictDoNothing({ target: [botAttendanceLog.userId, botAttendanceLog.loggedAt] }), botAttendanceLog.id);
        out.attendance_log = { received: t.attendance_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("attendance_log");

      // 3) balance_history — dedup by bot_id (must be present)
      if (t.balance_history) {
        const { rows, skippedInvalid } = split(t.balance_history, (r) => {
          const botId = asInt(r.bot_id, 0); if (!botId) return null;
          const userId = asStr(r.user_id); if (!userId) return null;
          const ts = parseTs(r.ts); if (!ts) return null;
          return { botId, userId, ts, cashDelta: asInt(r.cash_delta, 0), bankDelta: asInt(r.bank_delta, 0), reason: asStr(r.reason) };
        });
        const res = await chunkedInsert(botBalanceHistory, rows, (q) => q.onConflictDoNothing({ target: botBalanceHistory.botId }), botBalanceHistory.id);
        out.balance_history = { received: t.balance_history.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("balance_history");

      // 4) cyberware_status — PK user_id, upsert (latest wins)
      if (t.cyberware_status) {
        const { rows, skippedInvalid } = split(t.cyberware_status, (r) => {
          const userId = asStr(r.user_id); if (!userId) return null;
          return { userId, weeks: asInt(r.weeks, 0), lastProcessed: parseTs(r.last_processed), updatedAt: parseTs(r.updated_at) };
        });
        const res = await chunkedInsert(botCyberwareStatus, rows, (q) => q.onConflictDoUpdate({
          target: botCyberwareStatus.userId,
          set: { weeks: sql`excluded.weeks`, lastProcessed: sql`excluded.last_processed`, updatedAt: sql`excluded.updated_at` },
        }), botCyberwareStatus.userId);
        out.cyberware_status = { received: t.cyberware_status.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("cyberware_status");

      // 5) cyberware_weekly_runs — dedup by bot_id
      if (t.cyberware_weekly_runs) {
        const { rows, skippedInvalid } = split(t.cyberware_weekly_runs, (r) => {
          const botId = asInt(r.bot_id, 0); if (!botId) return null;
          const runAt = parseTs(r.run_at); if (!runAt) return null;
          return { botId, runAt, checkupIds: asArr(r.checkup_ids), paidIds: asArr(r.paid_ids), unpaidIds: asArr(r.unpaid_ids) };
        });
        const res = await chunkedInsert(botCyberwareWeeklyRuns, rows, (q) => q.onConflictDoNothing({ target: botCyberwareWeeklyRuns.botId }), botCyberwareWeeklyRuns.id);
        out.cyberware_weekly_runs = { received: t.cyberware_weekly_runs.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("cyberware_weekly_runs");

      // 6) last_payment — PK user_id, upsert
      if (t.last_payment) {
        const { rows, skippedInvalid } = split(t.last_payment, (r) => {
          const userId = asStr(r.user_id); if (!userId) return null;
          return { userId, summary: asStr(r.summary), updatedAt: parseTs(r.updated_at) };
        });
        const res = await chunkedInsert(botLastPayment, rows, (q) => q.onConflictDoUpdate({
          target: botLastPayment.userId,
          set: { summary: sql`excluded.summary`, updatedAt: sql`excluded.updated_at` },
        }), botLastPayment.userId);
        out.last_payment = { received: t.last_payment.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("last_payment");

      // 7) payment_labels — composite (user, label, ts); skip if ts missing
      if (t.payment_labels) {
        const { rows, skippedInvalid } = split(t.payment_labels, (r) => {
          const userId = asStr(r.user_id); const label = asStr(r.label); const recordedAt = parseTs(r.recorded_at);
          if (!userId || !label || !recordedAt) return null;
          return { userId, label, recordedAt };
        });
        const res = await chunkedInsert(botPaymentLabels, rows, (q) => q.onConflictDoNothing({ target: [botPaymentLabels.userId, botPaymentLabels.label, botPaymentLabels.recordedAt] }), botPaymentLabels.id);
        out.payment_labels = { received: t.payment_labels.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("payment_labels");

      // 8) rent_runs — dedup by bot_id
      if (t.rent_runs) {
        const { rows, skippedInvalid } = split(t.rent_runs, (r) => {
          const botId = asInt(r.bot_id, 0); if (!botId) return null;
          const runAt = parseTs(r.run_at); if (!runAt) return null;
          return { botId, runAt, initiatedBy: asStr(r.initiated_by) };
        });
        const res = await chunkedInsert(botRentRuns, rows, (q) => q.onConflictDoNothing({ target: botRentRuns.botId }), botRentRuns.id);
        out.rent_runs = { received: t.rent_runs.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("rent_runs");

      // 9) store_inventory — dedup by bot_id
      if (t.store_inventory) {
        const { rows, skippedInvalid } = split(t.store_inventory, (r) => {
          const botId = asInt(r.bot_id, 0); if (!botId) return null;
          const storeId = asStr(r.store_id); if (!storeId) return null;
          return {
            botId, storeId, lotId: asStr(r.lot_id), gunName: asStr(r.gun_name), gunLevel: asStr(r.gun_level),
            unitCost: asInt(r.unit_cost, 0), qty: asInt(r.qty, 0), itemIds: asArr(r.item_ids),
            restriction: asStr(r.restriction), weaponType: asStr(r.weapon_type), gunCategory: asStr(r.gun_category),
            createdAt: parseTs(r.created_at),
          };
        });
        const res = await chunkedInsert(botStoreInventory, rows, (q) => q.onConflictDoNothing({ target: botStoreInventory.botId }), botStoreInventory.id);
        out.store_inventory = { received: t.store_inventory.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("store_inventory");

      // 10) ticket_index — PK message_id, upsert
      if (t.ticket_index) {
        const { rows, skippedInvalid } = split(t.ticket_index, (r) => {
          const messageId = asStr(r.message_id); if (!messageId) return null;
          return { messageId, url: asStr(r.url), ts: parseTs(r.ts), title: asStr(r.title), body: asStr(r.body) };
        });
        const res = await chunkedInsert(botTicketIndex, rows, (q) => q.onConflictDoUpdate({
          target: botTicketIndex.messageId,
          set: { url: sql`excluded.url`, ts: sql`excluded.ts`, title: sql`excluded.title`, body: sql`excluded.body` },
        }), botTicketIndex.messageId);
        out.ticket_index = { received: t.ticket_index.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("ticket_index");

      // 11) mission_log — PK user_id, upsert
      if (t.mission_log) {
        const { rows, skippedInvalid } = split(t.mission_log, (r) => {
          const userId = asStr(r.user_id); if (!userId) return null;
          return {
            userId, username: asStr(r.username), missionCount: asInt(r.mission_count, 0),
            missionDates: asArr(r.mission_dates), missionTitles: asArr(r.mission_titles), updatedAt: parseTs(r.updated_at),
          };
        });
        const res = await chunkedInsert(botMissionLog, rows, (q) => q.onConflictDoUpdate({
          target: botMissionLog.userId,
          set: {
            username: sql`excluded.username`, missionCount: sql`excluded.mission_count`,
            missionDates: sql`excluded.mission_dates`, missionTitles: sql`excluded.mission_titles`,
            updatedAt: sql`excluded.updated_at`,
          },
        }), botMissionLog.userId);
        out.mission_log = { received: t.mission_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("mission_log");

      // 12) business_open_log — composite (user, ts); skip if ts missing
      if (t.business_open_log) {
        const { rows, skippedInvalid } = split(t.business_open_log, (r) => {
          const userId = asStr(r.user_id); const openedAt = parseTs(r.opened_at);
          if (!userId || !openedAt) return null;
          return { userId, openedAt };
        });
        const res = await chunkedInsert(botBusinessOpenLog, rows, (q) => q.onConflictDoNothing({ target: [botBusinessOpenLog.userId, botBusinessOpenLog.openedAt] }), botBusinessOpenLog.id);
        out.business_open_log = { received: t.business_open_log.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("business_open_log");

      // 13) player_inventory — PK item_id, upsert
      if (t.player_inventory) {
        const { rows, skippedInvalid } = split(t.player_inventory, (r) => {
          const itemId = asStr(r.item_id); if (!itemId) return null;
          return {
            itemId, ownerId: asStr(r.owner_id), characterId: asStr(r.character_id),
            characterName: asStr(r.character_name), itemType: asStr(r.item_type), name: asStr(r.name),
            restriction: asStr(r.restriction), description: asStr(r.description),
            pricePaid: r.price_paid == null ? null : asInt(r.price_paid, 0),
            sellerId: asStr(r.seller_id), sellerName: asStr(r.seller_name),
            acquiredAt: parseTs(r.acquired_at), createdAt: parseTs(r.created_at),
            powerLevel: asStr(r.power_level), weaponSubtype: asStr(r.weapon_subtype),
            cwp: asStr(r.cwp), slot: asStr(r.slot), weaponType: asStr(r.weapon_type),
          };
        });
        const res = await chunkedInsert(botPlayerInventory, rows, (q) => q.onConflictDoUpdate({
          target: botPlayerInventory.itemId,
          set: {
            ownerId: sql`excluded.owner_id`, characterId: sql`excluded.character_id`,
            characterName: sql`excluded.character_name`, itemType: sql`excluded.item_type`,
            name: sql`excluded.name`, restriction: sql`excluded.restriction`,
            description: sql`excluded.description`, pricePaid: sql`excluded.price_paid`,
            sellerId: sql`excluded.seller_id`, sellerName: sql`excluded.seller_name`,
            acquiredAt: sql`excluded.acquired_at`, powerLevel: sql`excluded.power_level`,
            weaponSubtype: sql`excluded.weapon_subtype`, cwp: sql`excluded.cwp`,
            slot: sql`excluded.slot`, weaponType: sql`excluded.weapon_type`,
          },
        }), botPlayerInventory.itemId);
        out.player_inventory = { received: t.player_inventory.length, inserted: res.inserted, skippedInvalid, chunkFailures: res.chunkFailures, note: res.lastError };
      } else skip("player_inventory");

      const totalIn = Object.values(out).reduce((s, x) => s + x.inserted, 0);
      const totalInvalid = Object.values(out).reduce((s, x) => s + x.skippedInvalid, 0);
      const totalChunkFail = Object.values(out).reduce((s, x) => s + x.chunkFailures, 0);
      await recordAudit({
        req,
        category: "admin",
        action: "bot_import",
        message: `Bot DB import: +${totalIn} new rows across ${Object.keys(out).length} tables, ${totalInvalid} invalid, ${totalChunkFail} chunk failures`,
        after: out,
      });
      res.json({ totals: { inserted: totalIn, skippedInvalid: totalInvalid, chunkFailures: totalChunkFail }, tables: out });
    },
  );

  // ---------------------------------------------------------------------------
  // Duplicate-character cleanup. The dev-to-prod and npc-import flows used to
  // match only on (kind,name) before the imported_from_thread_id resolver was
  // added, so name drift (smart quotes, manual renames) could spawn a second
  // row with an empty sheet. These endpoints let an admin REVIEW the duplicate
  // groups first, then MANUALLY pick which row to keep — the merge is opt-in
  // per pair because guessing wrong throws away inventory/wallet history.
  // ---------------------------------------------------------------------------

  router.get(
    "/admin/maintenance/duplicate-characters",
    adminOnly,
    async (_req, res): Promise<void> => {
      // Group by (kind, lower(trim(name))). Two characters with the same
      // name+kind are almost always the import artifact described above —
      // a real "two NPCs named John Smith" case is vanishingly rare in
      // this fiction and the admin can just decline to merge.
      const rows = await db
        .select({
          id: characters.id,
          name: characters.name,
          kind: characters.kind,
          ownerId: characters.ownerId,
          ownerName: users.username,
          archetype: characters.archetype,
          portraitUrl: characters.portraitUrl,
          portraitCount: sql<number>`coalesce(array_length(${characters.portraitUrls}, 1), 0)`,
          hasSheetData: sql<boolean>`${characters.sheetData} is not null`,
          importedFromThreadId: characters.importedFromThreadId,
          legacyDiscordUsername: characters.legacyDiscordUsername,
          approved: characters.approved,
          archived: characters.archived,
          lifeStatus: characters.lifeStatus,
          createdAt: characters.createdAt,
        })
        .from(characters)
        .leftJoin(users, eq(users.id, characters.ownerId))
        .orderBy(characters.name, desc(characters.createdAt));

      type Row = (typeof rows)[number];
      const groups = new Map<string, Row[]>();
      for (const r of rows) {
        // Normalize aggressively: import flows leave trailing tags like
        // " (NPC)" / "(PC)", smart-quote drift, double spaces, and case
        // mismatches on stop-words ("Alias" vs "alias"). Without this,
        // "Alex Graves (alias: Drew Camden)" and
        // "Alex Graves (Alias: Drew Camden) (NPC)" hash to different
        // keys and the admin never sees the pair.
        const key = `${r.kind}::${normalizeNameForDupes(r.name)}`;
        const list = groups.get(key) ?? [];
        list.push(r);
        groups.set(key, list);
      }
      const dupes = Array.from(groups.entries())
        .filter(([, list]) => list.length > 1)
        .map(([key, list]) => ({
          key,
          kind: list[0].kind,
          name: list[0].name,
          count: list.length,
          // Suggest the row with the richest data as the "keeper": prefer
          // ones with sheet_data, then with a portrait, then with an
          // owner, then the oldest row (most likely to have inventory
          // history). This is only a hint — the admin picks manually.
          suggestedKeepId: pickSuggestedKeep(list),
          rows: list,
        }))
        .sort((a, b) => b.count - a.count);

      res.json({ groupCount: dupes.length, totalDuplicateRows: dupes.reduce((s, g) => s + g.count, 0), groups: dupes });
    },
  );

  // ─── RipperDoc role backfill ──────────────────────────────────────────────
  // One-time (re-runnable, idempotent) grant of the "RipperDoc" Discord role to
  // every existing ripper doc, combining two signals (deduplicated):
  //   • characters whose archetype OR sheet occupation says "ripperdoc" (or the
  //     sheet's ripperDoc flag is set), and
  //   • anyone who owns or works at a ripperdoc clinic on the portal.
  // users.id IS the Discord snowflake, so we grant straight on owner_id. Discord
  // writes are gated by externalWritesAllowed() (deployment only), so this is
  // meant to be run from the published app. dryRun=true returns the target set
  // without touching Discord. On a successful grant we also set the website
  // "ripperdoc" role immediately; the hourly role_sync reconciles it both ways
  // via the id-pinned applyRoleIdGrants.
  router.post(
    "/admin/maintenance/ripperdoc-backfill",
    adminOnly,
    async (req, res): Promise<void> => {
      const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;
      // `ripper ?-?doc` matches ripperdoc / ripper doc / ripper-doc but NOT the
      // false-positive "stripper" that a bare "ripper" would catch.
      const RX = "ripper ?-?doc";
      const result = await db.execute(sql`
        WITH targets AS (
          SELECT DISTINCT c.owner_id AS user_id, 'sheet'::text AS source
          FROM characters c
          WHERE c.owner_id IS NOT NULL
            AND (lower(coalesce(c.archetype, '')) ~ ${RX}
                 OR lower(coalesce(c.sheet_data->>'occupation', '')) ~ ${RX}
                 OR c.sheet_data->>'ripperDoc' = 'true')
          UNION
          SELECT DISTINCT r.owner_id, 'clinic_owner'
          FROM ripperdocs r WHERE r.owner_id IS NOT NULL
          UNION
          SELECT DISTINCT c.owner_id, 'clinic_owner'
          FROM ripperdocs r JOIN characters c ON c.id = r.owner_character_id
          WHERE c.owner_id IS NOT NULL
          UNION
          SELECT DISTINCT c.owner_id, 'clinic_employee'
          FROM ripperdoc_employees e JOIN characters c ON c.id = e.character_id
          WHERE c.owner_id IS NOT NULL
        )
        SELECT t.user_id,
               u.username,
               string_agg(DISTINCT t.source, ',' ORDER BY t.source) AS sources
        FROM targets t
        LEFT JOIN users u ON u.id = t.user_id
        GROUP BY t.user_id, u.username
        ORDER BY u.username NULLS LAST
      `);
      const targets = ((result.rows ?? []) as Array<{
        user_id: string;
        username: string | null;
        sources: string;
      }>).map((t) => ({ userId: String(t.user_id), username: t.username, sources: t.sources }));

      // Only ever attempt the grant on real Discord snowflakes (17–20 digits).
      // Anything else is a legacy/non-Discord id we can't grant a role to.
      const isSnowflake = (id: string) => /^\d{17,20}$/.test(id);
      const grantable = targets.filter((t) => isSnowflake(t.userId));
      const skipped = targets.filter((t) => !isSnowflake(t.userId));

      if (dryRun) {
        res.json({
          dryRun: true,
          count: targets.length,
          grantable: grantable.length,
          skipped: skipped.length,
          externalWritesAllowed: externalWritesAllowed(),
          targets,
        });
        return;
      }

      let granted = 0;
      let failed = 0;
      const failures: Array<{ userId: string; username: string | null; error: string }> = [];
      for (const t of grantable) {
        const r = await addGuildMemberRole(t.userId, RIPPERDOC_ROLE_ID, "RipperDoc backfill");
        if (r.ok) {
          granted++;
          // Reflect on the website right away (no waiting for the hourly sync).
          await db.execute(sql`
            UPDATE users
            SET roles = array_append(coalesce(roles, '{}'::text[]), ${RIPPERDOC_ROLE_MARKER})
            WHERE id = ${t.userId}
              AND NOT (${RIPPERDOC_ROLE_MARKER} = ANY(coalesce(roles, '{}'::text[])))
          `);
        } else {
          failed++;
          failures.push({ userId: t.userId, username: t.username, error: r.error });
        }
      }

      await recordAudit({
        req,
        category: "admin",
        action: "ripperdoc_backfill",
        targetType: "role",
        targetId: RIPPERDOC_ROLE_ID,
        message: `RipperDoc backfill — granted ${granted}, failed ${failed}, skipped ${skipped.length} of ${targets.length} targets`,
      });

      res.json({
        count: targets.length,
        granted,
        failed,
        skipped: skipped.length,
        externalWritesAllowed: externalWritesAllowed(),
        failures: failures.slice(0, 50),
      });
    },
  );

  // ─── Maintenance operations (dry-run preview + confirmed live run) ────────
  // Each of the four ops below takes { dryRun } and returns a preview (targets,
  // counts) on dryRun=true or the applied results on a live run. Live runs write
  // an INLINE audit row (recordAuditInline throws on failure — the audit is part
  // of the operation's contract, unlike the fire-and-forget recordAudit).

  // 1) Backfill missing mission Discord threads. Discord writes are internally
  // gated on externalWritesAllowed() (deployment only) inside postToChannel.
  router.post(
    "/admin/maintenance/mission-thread-backfill",
    adminOnly,
    async (req, res): Promise<void> => {
      const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;
      const targets = await listMissionThreadBackfillTargets();
      const preview = targets.map((m) => ({
        id: m.id,
        title: m.title,
        missing: m.discordThreadId ? "snapshot" : "thread",
      }));
      if (dryRun) {
        await recordAuditInline(db, {
          req,
          category: "admin",
          action: "maintenance_mission_thread_backfill",
          targetType: "mission",
          message: `Mission thread backfill DRY RUN — ${targets.length} missions missing a thread/snapshot`,
          after: { dryRun: true, count: targets.length },
        });
        res.json({
          dryRun: true,
          count: targets.length,
          externalWritesAllowed: externalWritesAllowed(),
          targets: preview.slice(0, 100),
        });
        return;
      }
      // Discord thread creation is an external side effect, so there is no data
      // transaction to pair the audit with; it is recorded inline right after.
      const result = await runMissionThreadBackfill();
      await recordAuditInline(db, {
        req,
        category: "admin",
        action: "maintenance_mission_thread_backfill",
        targetType: "mission",
        message: `Mission thread backfill — scanned ${result.scanned}, created ${result.created}, seeded ${result.seeded}, failed ${result.failed}`,
        after: { dryRun: false, ...result },
      });
      res.json({ dryRun: false, externalWritesAllowed: externalWritesAllowed(), ...result });
    },
  );

  // 2) Economy reconcile for a single user: fold any Discord-side UnbelievaBoat
  // delta into the website wallet. Dry run computes the delta WITHOUT writing
  // (independent of the tri-state economy mode); the live run delegates to
  // reconcileOneUser, which still respects disabled/test modes.
  router.post(
    "/admin/maintenance/economy-reconcile",
    adminOnly,
    async (req, res): Promise<void> => {
      const body = req.body as { userId?: string; dryRun?: boolean } | null;
      const userId = typeof body?.userId === "string" ? body.userId.trim() : "";
      const dryRun = body?.dryRun === true;
      if (!userId) {
        res.status(400).json({ error: "Body must include userId" });
        return;
      }
      const [u] = await db.select().from(users).where(eq(users.id, userId));
      if (!u) {
        res.status(404).json({ error: "Unknown user" });
        return;
      }
      if (dryRun) {
        const ub = await getBalance(u.discordId);
        if (!ub) {
          res.status(502).json({ error: "Could not reach UnbelievaBoat" });
          return;
        }
        const baseline = u.lastSyncedUbBalance ?? u.walletBalance;
        const delta = ub.total - baseline;
        const summary = {
          dryRun: true,
          userId,
          username: u.username,
          walletBalance: u.walletBalance,
          ubBalance: ub.total,
          baseline,
          delta,
          wouldSeed: u.lastSyncedUbBalance === null,
        };
        await recordAuditInline(db, {
          req,
          category: "wallet",
          action: "maintenance_economy_reconcile",
          targetType: "user",
          targetId: userId,
          message: `Economy reconcile DRY RUN for ${u.username ?? userId} — delta ${delta} (wallet ${u.walletBalance}, UB ${ub.total})`,
          after: summary,
        });
        res.json(summary);
        return;
      }
      // The synced path audits INSIDE reconcileOneUser's wallet transaction via
      // onApplied, so the audit row commits atomically with the fold. All other
      // outcomes (disabled/test/no_change/unreachable) mutate nothing, so they
      // are audited inline afterwards.
      let auditedInTx = false;
      const result = await reconcileOneUser(userId, async (tx) => {
        auditedInTx = true;
        await recordAuditInline(tx, {
          req,
          category: "wallet",
          action: "maintenance_economy_reconcile",
          targetType: "user",
          targetId: userId,
          message: `Economy reconcile for ${u.username ?? userId} — applied UB delta to wallet`,
          after: { dryRun: false, status: "synced" },
        });
      });
      if (!auditedInTx) {
        await recordAuditInline(db, {
          req,
          category: "wallet",
          action: "maintenance_economy_reconcile",
          targetType: "user",
          targetId: userId,
          message: `Economy reconcile for ${u.username ?? userId} — ${result.status}, delta ${result.delta}, balance ${result.balance}`,
          after: { dryRun: false, ...result },
        });
      }
      res.json({ dryRun: false, userId, username: u.username, ...result });
    },
  );

  // 3) Repair UB balances for users whose last_synced_ub_balance diverges from
  // wallet_balance (historical website charges that never mirrored to UB).
  // dryRun=true lists all drifted users with drift amounts; the live run patches
  // UB by the drift, advances the baseline under a guard, and writes a forensic
  // ledger + audit row per user. Skips negative-wallet and pending-push users.
  router.post(
    "/admin/maintenance/ub-balance-repair",
    adminOnly,
    async (req, res): Promise<void> => {
      const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;

      if (dryRun) {
        const result = await runUbBalanceRepair({ dryRun: true });
        await recordAuditInline(db, {
          req,
          category: "wallet",
          action: "maintenance_ub_balance_repair",
          targetType: "system",
          message: `UB balance repair DRY RUN — ${result.totalDrifted} drifted users, ${result.eligible} eligible`,
          after: { dryRun: true, totalDrifted: result.totalDrifted, eligible: result.eligible },
        });
        res.json(result);
        return;
      }

      // Live run: recordAuditFn is called inside each user's wallet transaction
      // so the audit row commits atomically with the baseline advance.
      const result = await runUbBalanceRepair({
        dryRun: false,
        recordAuditFn: async (tx, userId, username, drift) => {
          await recordAuditInline(tx, {
            req,
            category: "wallet",
            action: "maintenance_ub_balance_repair",
            targetType: "user",
            targetId: userId,
            message: `UB balance repair for ${username}: advanced sync baseline by ${drift >= 0 ? "+" : ""}${drift}`,
            after: { userId, username, drift, dryRun: false },
          });
        },
      });
      // One summary audit row for the whole run.
      await recordAuditInline(db, {
        req,
        category: "wallet",
        action: "maintenance_ub_balance_repair",
        targetType: "system",
        message: `UB balance repair complete — repaired ${result.repaired} / ${result.totalDrifted} drifted users`,
        after: {
          dryRun: false,
          repaired: result.repaired,
          totalDrifted: result.totalDrifted,
          skippedPendingPushes: result.skippedPendingPushes,
          skippedNegativeTarget: result.skippedNegativeTarget,
          skippedUbUnreachable: result.skippedUbUnreachable,
          failed: result.failed,
        },
      });
      res.json(result);
    },
  );

  // 4) Re-host raw Discord guild-events CDN banners (signed URLs that 401 after
  // ~24h) into object storage at 2048px. Read-only against Discord's CDN, so no
  // deployment gate is needed; idempotent because rewritten rows no longer match.
  router.post(
    "/admin/maintenance/rehost-event-images",
    adminOnly,
    async (req, res): Promise<void> => {
      const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;
      const highResUrl = (imageUrl: string): string | null => {
        const m = imageUrl.match(/\/guild-events\/(\d+)\/([^./?]+)/);
        return m ? guildEventImageUrl(m[1]!, m[2]!) : null;
      };
      const rows = await db
        .select({ id: events.id, title: events.title, imageUrl: events.imageUrl })
        .from(events)
        .where(like(events.imageUrl, "https://cdn.discordapp.com/guild-events/%"));
      if (dryRun) {
        await recordAuditInline(db, {
          req,
          category: "admin",
          action: "maintenance_rehost_event_images",
          targetType: "event",
          message: `Event image rehost DRY RUN — ${rows.length} events with raw CDN banners`,
          after: { dryRun: true, count: rows.length },
        });
        res.json({
          dryRun: true,
          count: rows.length,
          targets: rows.slice(0, 100).map((r) => ({ id: r.id, title: r.title })),
        });
        return;
      }
      // Fetch/rehost outside any transaction (slow external reads), then commit
      // all row rewrites + the audit entry atomically in one transaction.
      let failed = 0;
      const failures: Array<{ id: number; title: string }> = [];
      const pending: Array<{ id: number; hosted: string }> = [];
      for (const row of rows) {
        const src = row.imageUrl ? highResUrl(row.imageUrl) : null;
        if (!src) continue;
        const hosted = await rehostEventImage(src);
        if (!hosted) {
          failed++;
          failures.push({ id: row.id, title: row.title });
          continue;
        }
        pending.push({ id: row.id, hosted });
      }
      const updated = pending.length;
      await db.transaction(async (tx) => {
        for (const p of pending) {
          await tx.update(events).set({ imageUrl: p.hosted }).where(eq(events.id, p.id));
        }
        await recordAuditInline(tx, {
          req,
          category: "admin",
          action: "maintenance_rehost_event_images",
          targetType: "event",
          message: `Event image rehost — ${updated} rehosted, ${failed} failed of ${rows.length} raw CDN banners`,
          after: { dryRun: false, scanned: rows.length, updated, failed },
        });
      });
      res.json({ dryRun: false, scanned: rows.length, updated, failed, failures: failures.slice(0, 50) });
    },
  );

  // 4) Re-scan guidebook page bodies and repair internal links against the
  // CURRENT doc/channel link maps. Pure DB operation (no Discord calls); the
  // audit row commits atomically with nothing else to pair with, so a plain
  // inline insert after the repair is sufficient (repair itself is idempotent).
  router.post(
    "/admin/maintenance/guidebook-link-repair",
    adminOnly,
    async (req, res): Promise<void> => {
      const dryRun = (req.body as { dryRun?: boolean } | null)?.dryRun === true;
      let result: Awaited<ReturnType<typeof repairGuidebookLinks>>;
      if (dryRun) {
        result = await repairGuidebookLinks(true);
        await recordAuditInline(db, {
          req,
          category: "admin",
          action: "maintenance_guidebook_link_repair",
          targetType: "guidebook",
          message: `Guidebook link repair DRY RUN — ${result.pagesChanged} pages would be rewritten (${result.totalRewrites} rewrites), ${result.brokenInternalLinks} broken internal links across ${result.scanned} pages`,
          after: {
            dryRun: true,
            scanned: result.scanned,
            pagesChanged: result.pagesChanged,
            totalRewrites: result.totalRewrites,
            brokenInternalLinks: result.brokenInternalLinks,
          },
        });
      } else {
        // Live repair: page rewrites + audit row commit in ONE transaction.
        result = await db.transaction(async (tx) => {
          const r = await repairGuidebookLinks(false, tx);
          await recordAuditInline(tx, {
            req,
            category: "admin",
            action: "maintenance_guidebook_link_repair",
            targetType: "guidebook",
            message: `Guidebook link repair — ${r.pagesChanged} pages rewritten (${r.totalRewrites} rewrites), ${r.brokenInternalLinks} broken internal links reported across ${r.scanned} pages`,
            after: {
              dryRun: false,
              scanned: r.scanned,
              pagesChanged: r.pagesChanged,
              totalRewrites: r.totalRewrites,
              brokenInternalLinks: r.brokenInternalLinks,
            },
          });
          return r;
        });
      }
      res.json({
        ...result,
        pages: result.pages.slice(0, 100),
      });
    },
  );

  router.post(
    "/admin/maintenance/merge-character",
    adminOnly,
    expressJson({ limit: "1mb" }),
    async (req, res): Promise<void> => {
      const body = req.body as { keepId?: number; dropId?: number; dryRun?: boolean } | null;
      const keepId = Number(body?.keepId);
      const dropId = Number(body?.dropId);
      if (!Number.isInteger(keepId) || !Number.isInteger(dropId) || keepId === dropId) {
        res.status(400).json({ error: "Body must be { keepId: int, dropId: int } with distinct ids" });
        return;
      }

      const [keep] = await db.select().from(characters).where(eq(characters.id, keepId));
      const [drop] = await db.select().from(characters).where(eq(characters.id, dropId));
      if (!keep || !drop) {
        res.status(404).json({ error: "keepId or dropId not found" });
        return;
      }
      if (keep.kind !== drop.kind) {
        res.status(400).json({ error: `Refusing to merge across kinds (keep=${keep.kind}, drop=${drop.kind})` });
        return;
      }

      // Count what we'd touch so the admin gets a clear before/after picture.
      // Done outside the txn so a dryRun is cheap and doesn't lock rows.
      const counts = await collectChildCounts(dropId);
      if (body?.dryRun) {
        res.json({
          dryRun: true,
          keep: summarizeForMerge(keep),
          drop: summarizeForMerge(drop),
          wouldRepoint: counts,
          wouldFillFields: diffFieldsForFill(keep, drop),
        });
        return;
      }

      // Real merge. Transaction so a mid-flight failure leaves the drop row
      // (and its FK children) intact rather than half-repointed.
      const result = await db.transaction(async (tx) => {
        // 1. Backfill empty/null fields on the keeper from the drop. We only
        //    fill where the keeper is empty — never overwrite live admin data.
        const updateSet: Record<string, unknown> = {};
        if (!keep.archetype && drop.archetype) updateSet.archetype = drop.archetype;
        if (!keep.background && drop.background) updateSet.background = drop.background;
        if (!keep.portraitUrl && drop.portraitUrl) updateSet.portraitUrl = drop.portraitUrl;
        if ((keep.portraitUrls?.length ?? 0) === 0 && (drop.portraitUrls?.length ?? 0) > 0) updateSet.portraitUrls = drop.portraitUrls;
        if ((keep.statsImageUrls?.length ?? 0) === 0 && (drop.statsImageUrls?.length ?? 0) > 0) updateSet.statsImageUrls = drop.statsImageUrls;
        if (!keep.sheetData && drop.sheetData) updateSet.sheetData = drop.sheetData as never;
        if (!keep.importedFromThreadId && drop.importedFromThreadId) updateSet.importedFromThreadId = drop.importedFromThreadId;
        if (!keep.importedFromChannelName && drop.importedFromChannelName) updateSet.importedFromChannelName = drop.importedFromChannelName;
        if ((keep.appliedTags?.length ?? 0) === 0 && (drop.appliedTags?.length ?? 0) > 0) updateSet.appliedTags = drop.appliedTags;
        if (!keep.legacyDiscordUsername && drop.legacyDiscordUsername) updateSet.legacyDiscordUsername = drop.legacyDiscordUsername;
        if (!keep.ownerId && drop.ownerId) updateSet.ownerId = drop.ownerId;
        if (!keep.discordChannelId && drop.discordChannelId) updateSet.discordChannelId = drop.discordChannelId;
        // The thread_id index is unique — if BOTH rows have a value we have
        // to clear drop's first (the delete at the end would also handle it,
        // but UPDATE...RETURNING below would also work; clearing keeps the
        // order obvious).
        if (drop.importedFromThreadId && keep.importedFromThreadId && drop.importedFromThreadId !== keep.importedFromThreadId) {
          await tx.update(characters).set({ importedFromThreadId: null }).where(eq(characters.id, dropId));
        }
        if (Object.keys(updateSet).length > 0) {
          await tx.update(characters).set(updateSet).where(eq(characters.id, keepId));
        }

        // 2. Repoint child rows on tables WITHOUT a unique constraint that
        //    would collide. Straight UPDATEs.
        const repoint: Record<string, number> = {};
        repoint.character_updates = (await tx.update(characterUpdates).set({ characterId: keepId }).where(eq(characterUpdates.characterId, dropId)).returning({ id: characterUpdates.id })).length;
        repoint.inventory_items = (await tx.update(inventoryItems).set({ characterId: keepId }).where(eq(inventoryItems.characterId, dropId)).returning({ id: inventoryItems.id })).length;
        repoint.store_employees = (await tx.update(storeEmployees).set({ characterId: keepId }).where(eq(storeEmployees.characterId, dropId)).returning({ id: storeEmployees.id })).length;
        repoint.ripperdoc_employees = (await tx.update(ripperdocEmployees).set({ characterId: keepId }).where(eq(ripperdocEmployees.characterId, dropId)).returning({ id: ripperdocEmployees.id })).length;
        repoint.housing = (await tx.update(housing).set({ characterId: keepId }).where(eq(housing.characterId, dropId)).returning({ id: housing.id })).length;
        repoint.housing_requests = (await tx.update(housingRequests).set({ characterId: keepId }).where(eq(housingRequests.characterId, dropId)).returning({ id: housingRequests.id })).length;
        repoint.trauma_team_calls = (await tx.update(traumaTeamCalls).set({ characterId: keepId }).where(eq(traumaTeamCalls.characterId, dropId)).returning({ id: traumaTeamCalls.id })).length;
        repoint.mission_log = (await tx.update(missionLog).set({ characterId: keepId }).where(eq(missionLog.characterId, dropId)).returning({ id: missionLog.id })).length;
        repoint.wallet_transactions = (await tx.update(walletTransactions).set({ characterId: keepId }).where(eq(walletTransactions.characterId, dropId)).returning({ id: walletTransactions.id })).length;
        repoint.wallet_counterparty = (await tx.update(walletTransactions).set({ counterpartyCharacterId: keepId }).where(eq(walletTransactions.counterpartyCharacterId, dropId)).returning({ id: walletTransactions.id })).length;
        repoint.inventory_events_from = (await tx.update(inventoryEvents).set({ fromCharacterId: keepId }).where(eq(inventoryEvents.fromCharacterId, dropId)).returning({ id: inventoryEvents.id })).length;
        repoint.inventory_events_to = (await tx.update(inventoryEvents).set({ toCharacterId: keepId }).where(eq(inventoryEvents.toCharacterId, dropId)).returning({ id: inventoryEvents.id })).length;
        repoint.stores_owner = (await tx.update(stores).set({ ownerCharacterId: keepId }).where(eq(stores.ownerCharacterId, dropId)).returning({ id: stores.id })).length;
        repoint.ripperdocs_owner = (await tx.update(ripperdocs).set({ ownerCharacterId: keepId }).where(eq(ripperdocs.ownerCharacterId, dropId)).returning({ id: ripperdocs.id })).length;
        repoint.character_sheets = (await tx.update(characterSheets).set({ characterId: keepId }).where(eq(characterSheets.characterId, dropId)).returning({ id: characterSheets.id })).length;
        repoint.dice_rolls = (await tx.update(diceRolls).set({ characterId: keepId }).where(eq(diceRolls.characterId, dropId)).returning({ id: diceRolls.id })).length;
        // These cascade-delete on character removal with no unique-on-characterId
        // constraint, so a plain repoint preserves them (previously they were
        // silently destroyed when the drop row was deleted below).
        repoint.custom_requests = (await tx.update(customRequests).set({ characterId: keepId }).where(eq(customRequests.characterId, dropId)).returning({ id: customRequests.id })).length;
        repoint.sale_offers = (await tx.update(saleOffers).set({ buyerCharacterId: keepId }).where(eq(saleOffers.buyerCharacterId, dropId)).returning({ id: saleOffers.id })).length;
        // sellerCharacterId is a plain column (no FK, no cascade), so seller-side
        // offers survive the drop's deletion but would dangle on the deleted id.
        // Repoint them too. No unique on sellerCharacterId, so this can't collide.
        repoint.sale_offers_seller = (await tx.update(saleOffers).set({ sellerCharacterId: keepId }).where(eq(saleOffers.sellerCharacterId, dropId)).returning({ id: saleOffers.id })).length;
        // mission_assignments.characterId is ON DELETE SET NULL (row survives but
        // loses its character link); repoint to preserve who was assigned. The
        // UNIQUE is on (missionId, userId) so changing characterId can't collide.
        repoint.mission_assignments = (await tx.update(missionAssignments).set({ characterId: keepId }).where(eq(missionAssignments.characterId, dropId)).returning({ id: missionAssignments.id })).length;
        // mission_applications: UNIQUE (missionId, characterId). Drop the drop's
        // application on missions the keeper already applied to, then repoint the
        // rest so the txn can't 23505 mid-merge.
        await tx.execute(sql`delete from mission_applications d
          where d.character_id = ${dropId}
            and exists (select 1 from mission_applications k where k.character_id = ${keepId} and k.mission_id = d.mission_id)`);
        repoint.mission_applications = (await tx.update(missionApplications).set({ characterId: keepId }).where(eq(missionApplications.characterId, dropId)).returning({ id: missionApplications.id })).length;

        // 3. Tables with a UNIQUE constraint on characterId: handle
        //    collisions explicitly so the txn doesn't 23505 mid-merge.
        // character_status: PK is characterId, so the keeper either has
        // one or doesn't.
        const [keepStatus] = await tx.select().from(characterStatus).where(eq(characterStatus.characterId, keepId));
        if (!keepStatus) {
          await tx.update(characterStatus).set({ characterId: keepId }).where(eq(characterStatus.characterId, dropId));
          repoint.character_status_moved = 1;
        } else {
          await tx.delete(characterStatus).where(eq(characterStatus.characterId, dropId));
          repoint.character_status_dropped = 1;
        }

        // shop_opens: UNIQUE (characterId, openedOn). Delete the drop's
        // opens on days the keeper already opened, then repoint the rest.
        await tx.execute(sql`delete from shop_opens d
          where d.character_id = ${dropId}
            and exists (select 1 from shop_opens k where k.character_id = ${keepId} and k.opened_on = d.opened_on)`);
        repoint.shop_opens = (await tx.update(shopOpens).set({ characterId: keepId }).where(eq(shopOpens.characterId, dropId)).returning({ id: shopOpens.id })).length;

        // pending_character_edits: UNIQUE (characterId WHERE status='pending').
        // If both have a pending edit, drop's pending edit becomes
        // 'superseded' so reviewers don't see two competing diffs.
        await tx.execute(sql`update pending_character_edits set status='superseded'
          where character_id = ${dropId} and status='pending'
            and exists (select 1 from pending_character_edits k where k.character_id = ${keepId} and k.status='pending')`);
        repoint.pending_edits = (await tx.update(pendingCharacterEdits).set({ characterId: keepId }).where(eq(pendingCharacterEdits.characterId, dropId)).returning({ id: pendingCharacterEdits.id })).length;

        // 4. Drop row should now have zero remaining child references. Any
        //    remaining cascade-on-delete children get nuked, which is the
        //    point — if we missed a table the data is gone.
        await tx.delete(characters).where(eq(characters.id, dropId));

        return { keepId, dropId, fieldsFilled: Object.keys(updateSet), repointed: repoint };
      });

      await recordAudit({
        req,
        category: "admin",
        action: "merge_character",
        targetType: "character",
        targetId: String(keepId),
        message: `Merged character #${dropId} (${drop.name}) into #${keepId} (${keep.name})`,
        before: { drop: summarizeForMerge(drop), keep: summarizeForMerge(keep) },
        after: result,
      });
      res.json(result);
    },
  );

  // ---------------------------------------------------------------------------
  // Account merge — fold a DROP user (e.g. a compromised/duplicate Discord
  // account) into a KEEP user. KEEP is the surviving login: it keeps its identity,
  // roles and tokens. Everything the DROP user owns or is referenced by is
  // repointed to KEEP, the DROP user's eddies are transferred ON UnbelievaBoat
  // into KEEP, and the DROP `users` row is finally deleted.
  //
  // Why a dedicated tool: `users.id` IS the Discord snowflake and the login key,
  // so a hacked account can't simply be "renamed". 50+ tables reference users.id;
  // most repoint cleanly, but a handful carry UNIQUE / PK constraints on the user
  // column that would 23505 on a naive UPDATE — those rows are de-duplicated
  // (drop's conflicting row deleted) before the repoint. The wallet is special:
  // the balance is mirrored to UnbelievaBoat keyed by Discord id and the reconcile
  // cron would revert a plain DB copy, so the eddies are moved via applyWalletDelta
  // (debit drop's UB account, credit keep's) which updates UB + ledger + balance +
  // the reconcile baseline in lockstep, idempotently.
  // ---------------------------------------------------------------------------
  router.post(
    "/admin/maintenance/merge-account",
    adminOnly,
    expressJson({ limit: "256kb" }),
    async (req, res) => {
      const body = req.body as { keepId?: unknown; dropId?: unknown; dryRun?: unknown } | null;
      const keepId = typeof body?.keepId === "string" ? body.keepId.trim() : "";
      const dropId = typeof body?.dropId === "string" ? body.dropId.trim() : "";
      const dryRun = body?.dryRun === true;

      if (!keepId || !dropId) {
        res.status(400).json({ error: "Both keepId and dropId are required." });
        return;
      }
      if (keepId === dropId) {
        res.status(400).json({ error: "keepId and dropId must be different." });
        return;
      }

      const [keep] = await db.select().from(users).where(eq(users.id, keepId));
      const [drop] = await db.select().from(users).where(eq(users.id, dropId));
      if (!keep) {
        res.status(404).json({ error: `Keep user ${keepId} not found.` });
        return;
      }
      if (!drop) {
        res.status(404).json({ error: `Drop user ${dropId} not found.` });
        return;
      }

      const transferAmount = drop.walletBalance ?? 0;
      const fieldsToFill: string[] = [];
      if (keep.defaultAvailability == null && drop.defaultAvailability != null) fieldsToFill.push("defaultAvailability");
      if (!keep.availabilityTimezone && drop.availabilityTimezone) fieldsToFill.push("availabilityTimezone");

      if (dryRun) {
        // Surface live UB balances too so the operator can confirm the website
        // mirror (transferAmount) matches the real eddies before committing.
        const [keepUb, dropUb] = await Promise.all([
          getBalance(keep.id, { allowStale: true }),
          getBalance(drop.id, { allowStale: true }),
        ]);
        res.json({
          dryRun: true,
          keep: summarizeUserForMerge(keep),
          drop: summarizeUserForMerge(drop),
          wouldTransferEddies: transferAmount,
          economyMode: await getEconomyMode(),
          liveUbBalance: { keep: keepUb?.total ?? null, drop: dropUb?.total ?? null },
          wouldFillFields: fieldsToFill,
          wouldRepoint: await collectAccountChildCounts(dropId),
        });
        return;
      }

      // --- Phase A: repoint every user-id reference drop -> keep ----------------
      // Done in one transaction. Collision tables (unique/PK on the user column)
      // delete drop's conflicting rows first, then repoint the rest. Historical
      // wallet_transactions are repointed here, BEFORE the balance transfer, so the
      // transfer's own debit row (created next, on drop) stays with drop and is
      // cascade-deleted with it — keeping keep's wallet history clean.
      const repointed: Record<string, number> = {};
      await db.transaction(async (tx) => {
        const repoint = async (table: string, col: string): Promise<number> => {
          const r = await tx.execute(
            sql`update ${sql.identifier(table)} set ${sql.identifier(col)} = ${keepId} where ${sql.identifier(col)} = ${dropId}`,
          );
          return r.rowCount ?? 0;
        };

        for (const [table, col] of ACCOUNT_PLAIN_USER_COLS) {
          const n = await repoint(table, col);
          if (n > 0) repointed[`${table}.${col}`] = n;
        }

        // Collision tables: delete drop's rows that would violate a UNIQUE/PK with
        // an existing keep row, then repoint the survivors. Equality (not NOT
        // DISTINCT FROM) on nullable sibling cols matches unique-index NULL
        // semantics (NULLs are distinct, so they never collide).
        await tx.execute(sql`delete from income_command_uses d where d.user_id = ${dropId} and exists (select 1 from income_command_uses k where k.user_id = ${keepId} and k.command = d.command)`);
        repointed["income_command_uses.user_id"] = (await tx.execute(sql`update income_command_uses set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from mission_assignments d where d.user_id = ${dropId} and exists (select 1 from mission_assignments k where k.user_id = ${keepId} and k.mission_id = d.mission_id)`);
        repointed["mission_assignments.user_id"] = (await tx.execute(sql`update mission_assignments set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from mission_actor_payments d where d.user_id = ${dropId} and d.payment_status = 'paid' and exists (select 1 from mission_actor_payments k where k.user_id = ${keepId} and k.payment_status = 'paid' and k.mission_id = d.mission_id)`);
        await tx.execute(sql`delete from mission_actor_payments d where d.user_id = ${dropId} and d.payment_status = 'paid' and d.event_id is not null and exists (select 1 from mission_actor_payments k where k.user_id = ${keepId} and k.payment_status = 'paid' and k.event_id = d.event_id)`);
        repointed["mission_actor_payments.user_id"] = (await tx.execute(sql`update mission_actor_payments set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from mission_npc_signups d where d.user_id = ${dropId} and d.state = 'signed_up' and exists (select 1 from mission_npc_signups k where k.user_id = ${keepId} and k.state = 'signed_up' and k.mission_id = d.mission_id)`);
        repointed["mission_npc_signups.user_id"] = (await tx.execute(sql`update mission_npc_signups set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from event_npc_signups d where d.user_id = ${dropId} and d.state = 'signed_up' and exists (select 1 from event_npc_signups k where k.user_id = ${keepId} and k.state = 'signed_up' and k.event_id = d.event_id)`);
        repointed["event_npc_signups.user_id"] = (await tx.execute(sql`update event_npc_signups set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from pending_edit_approvals d where d.voter_id = ${dropId} and exists (select 1 from pending_edit_approvals k where k.voter_id = ${keepId} and k.edit_id = d.edit_id)`);
        repointed["pending_edit_approvals.voter_id"] = (await tx.execute(sql`update pending_edit_approvals set voter_id = ${keepId} where voter_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from review_votes d where d.voter_id = ${dropId} and exists (select 1 from review_votes k where k.voter_id = ${keepId} and k.subject_type = d.subject_type and k.subject_id = d.subject_id)`);
        repointed["review_votes.voter_id"] = (await tx.execute(sql`update review_votes set voter_id = ${keepId} where voter_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from review_seen d where d.user_id = ${dropId} and exists (select 1 from review_seen k where k.user_id = ${keepId} and k.subject_type = d.subject_type and k.subject_id = d.subject_id)`);
        repointed["review_seen.user_id"] = (await tx.execute(sql`update review_seen set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from attendance_claims d where d.user_id = ${dropId} and exists (select 1 from attendance_claims k where k.user_id = ${keepId} and k.week_start = d.week_start)`);
        repointed["attendance_claims.user_id"] = (await tx.execute(sql`update attendance_claims set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from breach_practice_stats d where d.user_id = ${dropId} and exists (select 1 from breach_practice_stats k where k.user_id = ${keepId} and k.difficulty = d.difficulty)`);
        repointed["breach_practice_stats.user_id"] = (await tx.execute(sql`update breach_practice_stats set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        await tx.execute(sql`delete from vrchat_agents d where d.user_id = ${dropId} and exists (select 1 from vrchat_agents k where k.user_id = ${keepId})`);
        repointed["vrchat_agents.user_id"] = (await tx.execute(sql`update vrchat_agents set user_id = ${keepId} where user_id = ${dropId}`)).rowCount ?? 0;

        // Drop zero-count entries so the response only lists what actually moved.
        for (const key of Object.keys(repointed)) if (repointed[key] === 0) delete repointed[key];

        // Backfill only portable, non-identity fields onto keep where it's empty.
        const fill: Partial<typeof users.$inferInsert> = {};
        if (keep.defaultAvailability == null && drop.defaultAvailability != null) fill.defaultAvailability = drop.defaultAvailability;
        if (!keep.availabilityTimezone && drop.availabilityTimezone) fill.availabilityTimezone = drop.availabilityTimezone;
        if (Object.keys(fill).length > 0) {
          await tx.update(users).set(fill).where(eq(users.id, keepId));
        }
      });

      // --- Phase B: transfer eddies on UnbelievaBoat (idempotent) --------------
      // applyWalletDelta makes the external UB call + writes the ledger/balance +
      // advances the reconcile baseline, so it can't be inside the DB transaction.
      // Stable idempotency keys make the whole merge safe to re-run after a partial
      // failure. We MUST NOT delete the drop row unless the money actually moved.
      //
      // CRITICAL for reruns: do NOT gate on the *current* drop balance. If a prior
      // run debited drop (balance now 0) but the credit failed, recomputing the
      // amount from drop.walletBalance would skip Phase B and delete drop with the
      // eddies stranded. Instead, if a debit ledger row already exists for this
      // merge, trust ITS amount as the authoritative plan so the credit always
      // gets retried (applyWalletDelta de-dupes the debit leg by key).
      const debitKey = `account-merge:${dropId}->${keepId}:out`;
      const creditKey = `account-merge:${dropId}->${keepId}:in`;
      const [priorDebit] = await db
        .select({ amount: walletTransactions.amount })
        .from(walletTransactions)
        .where(eq(walletTransactions.idempotencyKey, debitKey));
      const plannedAmount = priorDebit ? Math.abs(priorDebit.amount) : transferAmount;

      let walletTransfer: Record<string, unknown> = { amount: 0, skipped: true };
      if (plannedAmount > 0) {
        const debit = await applyWalletDelta({
          userId: dropId,
          discordId: drop.id,
          amount: -plannedAmount,
          source: "admin",
          kind: "account_merge_out",
          reason: `Account merge: transfer to ${keepId}`,
          memo: `Account merge: eddies moved to user ${keepId}`,
          idempotencyKey: debitKey,
        });
        if (!debit.ok || (debit.status !== "synced" && debit.status !== "duplicate")) {
          res.status(409).json({
            error: `Eddies debit from the drop account did not complete (status=${debit.status}). Nothing was deleted. The economy must be LIVE (enabled) for the transfer to run; child rows were already repointed and re-running the merge will retry safely.`,
            repointed,
            walletTransfer: { debit },
          });
          return;
        }
        const credit = await applyWalletDelta({
          userId: keepId,
          discordId: keep.id,
          amount: plannedAmount,
          source: "admin",
          kind: "account_merge_in",
          reason: `Account merge: transfer from ${dropId}`,
          memo: `Account merge: eddies received from user ${dropId}`,
          idempotencyKey: creditKey,
        });
        if (!credit.ok || (credit.status !== "synced" && credit.status !== "duplicate")) {
          res.status(409).json({
            error: `Eddies were debited from the drop account but the credit to the keep account did not complete (status=${credit.status}). Nothing was deleted — re-run the merge to retry; the debit will not repeat.`,
            repointed,
            walletTransfer: { debit, credit },
          });
          return;
        }
        walletTransfer = { amount: plannedAmount, debit: debit.status, credit: credit.status };
      }

      // --- Phase C: delete the drop user row -----------------------------------
      // All non-cascade references were repointed in Phase A; the only remaining
      // child rows are cascade FKs (e.g. the Phase-B debit ledger row) which the
      // delete cleans up. This is the point of no return.
      await db.transaction(async (tx) => {
        await tx.delete(users).where(eq(users.id, dropId));
      });

      const result = {
        keepId,
        dropId,
        fieldsFilled: fieldsToFill,
        repointed,
        walletTransfer,
      };

      await recordAudit({
        req,
        category: "admin",
        action: "merge_account",
        targetType: "user",
        targetId: keepId,
        message: `Merged account ${dropId} (${drop.username ?? "?"}) into ${keepId} (${keep.username ?? "?"}); transferred €${plannedAmount.toLocaleString()}`,
        before: { drop: summarizeUserForMerge(drop), keep: summarizeUserForMerge(keep) },
        after: result,
      });

      res.json(result);
    },
  );

  // ---------------------------------------------------------------------------
  // Claim-by-username. Unclaimed characters carry `legacyDiscordUsername`
  // (the Discord handle the sheet was authored under). When that user later
  // logs into the portal we get a `users` row with the same username — this
  // endpoint links them. Case-insensitive name match, never overwrites an
  // existing ownerId, never matches when the dev row owner is ambiguous
  // (>1 users share the legacy username).
  // ---------------------------------------------------------------------------

  router.get(
    "/admin/maintenance/claim-by-username",
    adminOnly,
    async (_req, res): Promise<void> => {
      const matches = await previewClaimByUsername();
      res.json({
        candidateCount: matches.length,
        ambiguousCount: matches.filter((m) => m.matchedUserIds.length > 1).length,
        matches,
      });
    },
  );

  router.post(
    "/admin/maintenance/claim-by-username",
    adminOnly,
    expressJson({ limit: "100kb" }),
    async (req, res): Promise<void> => {
      const body = req.body as { dryRun?: boolean } | null;
      const matches = await previewClaimByUsername();
      if (body?.dryRun) {
        res.json({ dryRun: true, candidateCount: matches.length, matches });
        return;
      }
      const applied: Array<{ characterId: number; characterName: string; ownerId: string; matchedUsername: string }> = [];
      const skipped: Array<{ characterId: number; characterName: string; reason: string }> = [];
      for (const m of matches) {
        if (m.matchedUserIds.length !== 1) {
          skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: m.matchedUserIds.length === 0 ? "no_match" : `ambiguous (${m.matchedUserIds.length} users)` });
          continue;
        }
        const ownerId = m.matchedUserIds[0];
        try {
          // Guard on still-unclaimed and check rows affected: if the character was
          // claimed concurrently (or manually) the UPDATE matches 0 rows, so don't
          // falsely report it as linked.
          const updated = await db
            .update(characters)
            .set({ ownerId, claimed: true })
            .where(and(eq(characters.id, m.characterId), isNull(characters.ownerId)))
            .returning({ id: characters.id });
          if (updated.length === 0) {
            skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: "already_claimed" });
          } else {
            applied.push({ characterId: m.characterId, characterName: m.characterName, ownerId, matchedUsername: m.legacyDiscordUsername });
          }
        } catch (err) {
          skipped.push({ characterId: m.characterId, characterName: m.characterName, reason: (err as Error).message });
        }
      }

      await recordAudit({
        req,
        category: "admin",
        action: "claim_by_username",
        message: `Claim-by-username: linked ${applied.length}, skipped ${skipped.length}`,
        after: { applied: applied.length, skipped: skipped.length },
      });
      res.json({ applied, skipped });
    },
  );

  router.get(
    "/admin/maintenance/portrait-backfill",
    adminOnly,
    async (_req, res): Promise<void> => {
      const candidates = await listPortraitBackfillCandidates();
      res.json({
        total: candidates.length,
        withAttachment: candidates.filter((c) => c.attachmentCount > 0).length,
        candidates,
      });
    },
  );

  router.post(
    "/admin/maintenance/portrait-backfill",
    adminOnly,
    async (req, res): Promise<void> => {
      // Body shape: { characterIds?: number[] }. Empty/omitted = apply to every
      // candidate the preview turned up that has at least one attachment.
      const requested = Array.isArray(req.body?.characterIds)
        ? (req.body.characterIds as unknown[]).map(Number).filter((n): n is number => Number.isInteger(n))
        : null;

      const candidates = await listPortraitBackfillCandidates();
      const targets = candidates.filter(
        (c) => c.attachmentCount > 0 && (requested === null || requested.includes(c.characterId)),
      );

      const storage = new ObjectStorageService();
      const applied: Array<{ characterId: number; characterName: string; portraitUrl: string; sourceFilename: string }> = [];
      const skipped: Array<{ characterId: number; characterName: string; reason: string }> = [];

      for (const cand of targets) {
        try {
          const msg = await fetchThreadOpMessage(cand.threadId);
          const first = imageAttachmentsOf(msg)[0];
          if (!first) {
            skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: "attachment disappeared between preview and apply" });
            continue;
          }
          // Download from Discord CDN.
          const dl = await fetch(first.url, { signal: AbortSignal.timeout(30_000) });
          if (!dl.ok) {
            skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: `cdn download failed: HTTP ${dl.status}` });
            continue;
          }
          const ab = await dl.arrayBuffer();
          const buf = Buffer.from(ab);
          const contentType = first.contentType
            ?? dl.headers.get("content-type")
            ?? "application/octet-stream";
          const path = await storage.uploadBuffer(buf, contentType);

          // Guard against a race: another writer may have set a portrait
          // between preview and apply — don't clobber it.
          const updated = await db
            .update(characters)
            .set({
              portraitUrl: path,
              portraitUrls: sql`array_append(${characters.portraitUrls}, ${path})`,
            })
            .where(
              and(
                eq(characters.id, cand.characterId),
                isNull(characters.portraitUrl),
              ),
            )
            .returning({ id: characters.id });
          if (updated.length === 0) {
            skipped.push({ characterId: cand.characterId, characterName: cand.characterName, reason: "character already has a portrait; left untouched" });
            continue;
          }
          applied.push({
            characterId: cand.characterId,
            characterName: cand.characterName,
            portraitUrl: path,
            sourceFilename: first.filename,
          });
        } catch (err) {
          skipped.push({
            characterId: cand.characterId,
            characterName: cand.characterName,
            reason: `error: ${(err as Error).message}`,
          });
        }
      }

      await recordAudit({
        req,
        category: "character",
        action: "portrait.backfill",
        targetType: "system",
        targetId: "characters",
        after: { applied: applied.length, skipped: skipped.length },
      });

      res.json({ requested: targets.length, applied, skipped });
    },
  );
}
