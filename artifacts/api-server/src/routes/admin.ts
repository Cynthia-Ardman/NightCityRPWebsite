import { Router, type IRouter } from "express";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import { db, users, characters, walletTransactions, jobRuns, activityEvents, botConfig } from "@workspace/db";
import { requireAuth, requireRole, requireAnyRole } from "../middlewares/auth";
import { fetchGuildMemberRolesViaBot, fetchDiscordUser, hasRole } from "../lib/discord";
import { patchBalance, getBalance } from "../lib/unbelievaboat";
import { runJob } from "../lib/jobs";

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

router.post("/admin/wallet/adjust", async (req, res): Promise<void> => {
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
  res.json({ success: true });
});

router.get("/admin/jobs", async (_req, res): Promise<void> => {
  const rows = await db.select().from(jobRuns).orderBy(desc(jobRuns.startedAt)).limit(50);
  res.json(rows);
});

router.post("/admin/jobs/run", async (req, res): Promise<void> => {
  const job = String(req.body?.job ?? "");
  if (!["cyberware_humanity", "monthly_rent", "role_sync"].includes(job)) {
    res.status(400).json({ error: "Unknown job" });
    return;
  }
  const result = await runJob(job as "cyberware_humanity" | "monthly_rent" | "role_sync");
  res.json(result);
});

router.get("/admin/activity", async (_req, res): Promise<void> => {
  const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(100);
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

router.get("/admin/stats", async (_req, res): Promise<void> => {
  const [{ count: userCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const [{ count: charCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(characters);
  res.json({ userCount, charCount });
});

export default router;
