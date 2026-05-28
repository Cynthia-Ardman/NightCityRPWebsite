import { Router, type IRouter, json as expressJson } from "express";
import { eq, desc, sql, and, gte, type SQL } from "drizzle-orm";
import { db, users, characters, walletTransactions, jobRuns, activityEvents, botConfig, characterStatus, housing, catalogRent } from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { fetchGuildMemberRolesViaBot, fetchDiscordUser, hasRole } from "../lib/discord";
import { patchBalance, getBalance } from "../lib/unbelievaboat";
import { runJob } from "../lib/jobs";
import { recordAudit } from "../lib/audit";
import { auditLog } from "@workspace/db";

const router: IRouter = Router();

// Most /admin routes are ADMIN-only, but the character listing + owner
// assign/clear endpoints are also exposed to FIXER (the in-fiction canon
// enforcer role). Auth is required for everything under /admin.
//
// IMPORTANT: we scope to "/admin" so this router does not intercept
// requests that fall through to sibling routers mounted after it
// (e.g. /storage/*, /housing/*). Express applies `router.use(mw)` to
// every request the sub-router sees, regardless of whether any local
// route matches — without the path scope, this would return 401 for
// every unauthenticated call on the entire API.
router.use("/admin", requireAuth);
const adminOnly = requireRole("ADMIN");
const adminOrFixer = requireAnyRole(["ADMIN", "FIXER"]);

router.get("/admin/users", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(users).orderBy(desc(users.lastSeenAt));
  res.json(
    rows.map((u) => ({
      id: u.id,
      discordId: u.discordId,
      username: u.username,
      globalName: u.globalName,
      avatarUrl: u.avatarUrl,
      roles: u.roles,
      isAdmin: hasRole(u.roles, "ADMIN"),
      isFixer: hasRole(u.roles, "FIXER"),
      isCsApprover: hasRole(u.roles, "CS_APPROVER"),
      isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
      isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
      lastSeenAt: u.lastSeenAt,
      rolesSyncedAt: u.rolesSyncedAt,
    })),
  );
});

router.get("/admin/users/:userId", adminOnly, async (req, res): Promise<void> => {
  const id = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const chars = await db.select().from(characters).where(eq(characters.ownerId, id));
  res.json({
    id: u.id,
    discordId: u.discordId,
    username: u.username,
    globalName: u.globalName,
    avatarUrl: u.avatarUrl,
    roles: u.roles,
    isAdmin: hasRole(u.roles, "ADMIN"),
    isFixer: hasRole(u.roles, "FIXER"),
    isCsApprover: hasRole(u.roles, "CS_APPROVER"),
    isRipperdoc: hasRole(u.roles, "RIPPERDOC"),
    isStoreOwner: hasRole(u.roles, "STORE_OWNER"),
    lastSeenAt: u.lastSeenAt,
    rolesSyncedAt: u.rolesSyncedAt,
    characters: chars,
  });
});

// Bulk-hydrate users from Discord. Walks every users row, calls the Discord
// API by discordId, and overwrites username / globalName / avatarUrl when
// Discord returns a profile. Targets rows whose `username` is still the
// `user_<last6>` placeholder the prod-DB importer inserted, but `force=true`
// re-hydrates everyone. Returns counts so the UI can show what happened.
router.post("/admin/users/hydrate", adminOnly, async (req, res): Promise<void> => {
  const force = Boolean((req.body ?? {}).force);
  const rows = await db.select().from(users);
  const targets = force
    ? rows
    : rows.filter((u) => /^user_[A-Za-z0-9]+$/.test(u.username));
  let updated = 0;
  let missing = 0;
  for (const u of targets) {
    const profile = await fetchDiscordUser(u.discordId);
    if (!profile) {
      missing++;
      continue;
    }
    await db
      .update(users)
      .set({
        username: profile.username,
        globalName: profile.globalName,
        avatarUrl: profile.avatarUrl,
      })
      .where(eq(users.id, u.id));
    updated++;
  }
  res.json({ scanned: targets.length, updated, missing });
});

router.post("/admin/users/:userId/roles", adminOnly, async (req, res): Promise<void> => {
  const id = String(req.params.userId);
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const roles = await fetchGuildMemberRolesViaBot(u.discordId);
  await db.update(users).set({ roles, rolesSyncedAt: new Date() }).where(eq(users.id, id));
  res.json({ roles, rolesSyncedAt: new Date() });
});

router.get("/admin/characters", adminOrFixer, async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: characters.id,
      ownerId: characters.ownerId,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      approved: characters.approved,
      archived: characters.archived,
      claimed: characters.claimed,
      lifeStatus: characters.lifeStatus,
      legacyDiscordUsername: characters.legacyDiscordUsername,
      importedFromChannelName: characters.importedFromChannelName,
      createdAt: characters.createdAt,
      ownerName: users.username,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .orderBy(desc(characters.createdAt));
  res.json(rows);
});

// Assign or reassign the ownerId of an imported character. Used by the
// admin/fixer UI to claim an unclaimed sheet for a player who returned to
// the server under a different account.
router.put("/admin/characters/:id/owner", adminOrFixer, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const { ownerId } = (req.body ?? {}) as { ownerId?: string };
  if (!ownerId) {
    res.status(400).json({ error: "ownerId required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  const [u] = await db.select().from(users).where(eq(users.id, ownerId));
  if (!u) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  const [updated] = await db
    .update(characters)
    .set({ ownerId, claimed: true })
    .where(eq(characters.id, id))
    .returning();
  await db.insert(activityEvents).values({
    kind: "character_claimed",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} assigned ${c.name} to ${u.username}`,
  });
  res.json({ ...updated, isActive: false });
});

router.delete("/admin/characters/:id/owner", adminOrFixer, async (req, res): Promise<void> => {
  const id = parseInt(String(req.params.id), 10);
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const [updated] = await db
    .update(characters)
    .set({ ownerId: null, claimed: false })
    .where(eq(characters.id, id))
    .returning();
  await db.insert(activityEvents).values({
    kind: "character_unclaimed",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} cleared ownership of ${c.name}`,
  });
  res.json({ ...updated, isActive: false });
});

// Ripperdoc checkup. Records a checkup, resets the missed-checkup streak
// to zero, and optionally re-bands the character's cyberwareLevel
// (none|medium|high|extreme) which drives the weekly meds formula.
// Authorized for ADMIN or RIPPERDOC — staff still cover for clinics with
// no on-call doc, but a doc can run their own clinic without needing
// admin tokens.
const CYBERWARE_LEVELS = new Set(["none", "medium", "high", "extreme"]);

router.post("/admin/characters/:id/checkup", requireAuth, async (req, res): Promise<void> => {
  const u = req.user!;
  if (!hasRole(u.roles ?? [], "ADMIN") && !hasRole(u.roles ?? [], "RIPPERDOC")) {
    res.status(403).json({ error: "Admin or ripperdoc role required" });
    return;
  }
  const id = parseInt(String(req.params.id), 10);
  const [c] = await db.select().from(characters).where(eq(characters.id, id));
  if (!c) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  // Optional re-band. If provided, must be a known level. Falsy/undefined
  // means "leave the existing level alone" — a checkup without re-banding
  // is the common case for already-classified players.
  const rawLevel = typeof req.body?.cyberwareLevel === "string"
    ? req.body.cyberwareLevel.toLowerCase().trim()
    : "";
  if (rawLevel && !CYBERWARE_LEVELS.has(rawLevel)) {
    res.status(400).json({ error: `cyberwareLevel must be one of: ${[...CYBERWARE_LEVELS].join(", ")}` });
    return;
  }
  const patch: Record<string, unknown> = { lastCheckupAt: new Date(), checkupStreak: 0 };
  if (rawLevel) patch.cyberwareLevel = rawLevel;
  const [updated] = await db
    .update(characters)
    .set(patch)
    .where(eq(characters.id, id))
    .returning();
  const levelNote = rawLevel ? ` (level: ${rawLevel})` : "";
  await db.insert(activityEvents).values({
    kind: "checkup",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} recorded a ripperdoc checkup for ${c.name}${levelNote}`,
  });
  await recordAudit({
    req,
    category: "character",
    action: "checkup",
    targetType: "character",
    targetId: id,
    message: `Ripperdoc checkup for ${c.name}${levelNote}`,
    before: { cyberwareLevel: c.cyberwareLevel, checkupStreak: c.checkupStreak },
    after: { cyberwareLevel: updated.cyberwareLevel, checkupStreak: updated.checkupStreak },
  });
  res.json({
    characterId: updated.id,
    lastCheckupAt: updated.lastCheckupAt?.toISOString() ?? null,
    checkupStreak: updated.checkupStreak,
    cyberwareLevel: updated.cyberwareLevel,
  });
});

router.post("/admin/wallet/adjust", adminOnly, async (req, res): Promise<void> => {
  const { characterId, amount, memo } = req.body ?? {};
  if (!characterId || typeof amount !== "number") {
    res.status(400).json({ error: "characterId and amount required" });
    return;
  }
  const [c] = await db.select().from(characters).where(eq(characters.id, characterId));
  if (!c) {
    res.status(404).json({ error: "Character not found" });
    return;
  }
  if (!c.ownerId) {
    res.status(400).json({ error: "Character has no owner (unclaimed)" });
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
  if (!owner) {
    res.status(404).json({ error: "Character owner not found" });
    return;
  }
  // UB is authoritative — do not write a local ledger entry unless UB write succeeds.
  const ubResult = await patchBalance(owner.discordId, { cash: amount, reason: memo ?? "Admin adjustment" });
  if (!ubResult) {
    res.status(502).json({ error: "Wallet provider unavailable or rejected adjustment" });
    return;
  }
  await db.insert(walletTransactions).values({
    characterId,
    amount,
    kind: "admin",
    memo: memo ?? null,
    counterpartyName: req.user!.username,
  });
  await recordAudit({
    req,
    category: "wallet",
    action: "admin_adjust",
    targetType: "character",
    targetId: characterId,
    message: `${req.user!.username} adjusted ${c.name} by ${amount >= 0 ? "+" : ""}${amount}`,
    after: { amount, memo: memo ?? null, ownerDiscordId: owner.discordId },
  });
  res.json({ success: true });
});

router.get("/admin/jobs", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
  res.json(rows);
});

router.post("/admin/jobs/run", adminOnly, async (req, res): Promise<void> => {
  const job = String(req.body?.job ?? "");
  if (!["cyberware_humanity", "monthly_rent", "role_sync", "eviction_sweep"].includes(job)) {
    res.status(400).json({ error: "Unknown job" });
    return;
  }
  const result = await runJob(job as "cyberware_humanity" | "monthly_rent" | "role_sync" | "eviction_sweep");
  res.json(result);
});

router.get("/admin/activity", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(100);
  res.json(rows);
});

// New unified audit log feed (separate from /admin/audit which still reads the
// legacy player-facing activity_events). Supports category/action/actor
// filters and a since cursor.
router.get("/admin/audit-log", adminOnly, async (req, res): Promise<void> => {
  const category = req.query.category ? String(req.query.category) : null;
  const action = req.query.action ? String(req.query.action) : null;
  const actorId = req.query.actorId ? String(req.query.actorId) : null;
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const limit = Math.min(500, parseInt(String(req.query.limit ?? "200"), 10) || 200);
  const conds: SQL[] = [
    category && category !== "all" ? eq(auditLog.category, category) : null,
    action ? eq(auditLog.action, action) : null,
    actorId ? eq(auditLog.actorId, actorId) : null,
    since && !isNaN(since.getTime()) ? gte(auditLog.createdAt, since) : null,
  ].filter((c): c is SQL => c !== null);
  const rows = conds.length
    ? await db.select().from(auditLog).where(and(...conds)).orderBy(desc(auditLog.createdAt)).limit(limit)
    : await db.select().from(auditLog).orderBy(desc(auditLog.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin/audit", adminOnly, async (req, res): Promise<void> => {
  const kind = req.query.kind ? String(req.query.kind) : null;
  const actorId = req.query.actorId ? String(req.query.actorId) : null;
  const since = req.query.since ? new Date(String(req.query.since)) : null;
  const limit = Math.min(500, parseInt(String(req.query.limit ?? "100"), 10) || 100);
  const conds = [
    kind ? eq(activityEvents.kind, kind) : null,
    actorId ? eq(activityEvents.actorId, actorId) : null,
    since && !isNaN(since.getTime()) ? gte(activityEvents.createdAt, since) : null,
  ].filter(Boolean) as ReturnType<typeof eq>[];
  const rows = conds.length
    ? await db.select().from(activityEvents).where(and(...conds)).orderBy(desc(activityEvents.createdAt)).limit(limit)
    : await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(limit);
  res.json(rows);
});

router.get("/admin/bot-config", adminOnly, async (_req, res): Promise<void> => {
  const rows = await db.select().from(botConfig).orderBy(botConfig.key);
  res.json(rows);
});

router.put("/admin/bot-config/:key", adminOnly, async (req, res): Promise<void> => {
  const key = String(req.params.key);
  if (!key) {
    res.status(400).json({ error: "key required" });
    return;
  }
  const { value } = req.body ?? {};
  if (value === undefined) {
    res.status(400).json({ error: "value required" });
    return;
  }
  const [row] = await db
    .insert(botConfig)
    .values({ key, value })
    .onConflictDoUpdate({ target: botConfig.key, set: { value, updatedAt: new Date() } })
    .returning();
  await db.insert(activityEvents).values({
    kind: "bot_config_set",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} updated bot_config.${key}`,
  });
  res.json(row);
});

router.delete("/admin/bot-config/:key", adminOnly, async (req, res): Promise<void> => {
  const key = String(req.params.key);
  await db.delete(botConfig).where(eq(botConfig.key, key));
  await db.insert(activityEvents).values({
    kind: "bot_config_delete",
    actorId: req.user!.id,
    actorName: req.user!.username,
    actorAvatarUrl: req.user!.avatarUrl,
    message: `${req.user!.username} removed bot_config.${key}`,
  });
  res.sendStatus(204);
});

router.get("/admin/stats", adminOnly, async (_req, res): Promise<void> => {
  const [{ count: userCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const [{ count: charCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(characters);
  res.json({ userCount, charCount });
});

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
        const existing = await db
          .select({ id: characters.id })
          .from(characters)
          .where(and(eq(characters.kind, "npc"), eq(characters.name, npc.name)))
          .limit(1);
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
          const updateSet: Record<string, unknown> = {
            approved: npc.approved ?? true,
            claimed: npc.claimed ?? false,
          };
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
          await db.update(characters).set(updateSet).where(eq(characters.id, existing[0].id));
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

    // ---- 2) characters (upsert by kind+name) -------------------------------
    for (const raw of body.characters ?? []) {
      const r = raw as unknown as Record<string, unknown>;
      const name = (raw.name as string | undefined)?.trim();
      const kind = (raw.kind as string | undefined) ?? "npc";
      if (!name) { result.characters.skipped++; continue; }
      try {
        const existing = await db
          .select({ id: characters.id })
          .from(characters)
          .where(and(eq(characters.kind, kind), eq(characters.name, name)))
          .limit(1);
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
          await db.insert(characters).values({ ...values, ownerId: safeOwnerId });
          result.characters.inserted++;
        } else {
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

    // Build prod-side (kind|name) -> id map for the linked tables.
    const allRows = await db
      .select({ id: characters.id, kind: characters.kind, name: characters.name })
      .from(characters);
    const idByName = new Map<string, number>();
    for (const r of allRows) idByName.set(`${r.kind}|${r.name.toLowerCase()}`, r.id);
    const lookup = (kind?: string, name?: string): number | undefined =>
      kind && name ? idByName.get(`${kind}|${name.toLowerCase()}`) : undefined;

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

export default router;
