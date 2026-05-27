import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import { db, users, characters, walletTransactions, jobRuns, activityEvents } from "@workspace/db";
import { requireAuth, requireRole } from "../middlewares/auth";
import { fetchGuildMemberRolesViaBot, hasRole } from "../lib/discord";
import { patchBalance } from "../lib/unbelievaboat";
import { runJob } from "../lib/jobs";

const router: IRouter = Router();

router.use(requireAuth, requireRole("ADMIN"));

router.get("/admin/users", async (_req, res): Promise<void> => {
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

router.get("/admin/users/:id", async (req, res): Promise<void> => {
  const id = String(req.params.id);
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

router.post("/admin/users/:id/sync-roles", async (req, res): Promise<void> => {
  const id = String(req.params.id);
  const [u] = await db.select().from(users).where(eq(users.id, id));
  if (!u) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const roles = await fetchGuildMemberRolesViaBot(u.discordId);
  await db.update(users).set({ roles, rolesSyncedAt: new Date() }).where(eq(users.id, id));
  res.json({ roles, rolesSyncedAt: new Date() });
});

router.get("/admin/characters", async (_req, res): Promise<void> => {
  const rows = await db
    .select({
      id: characters.id,
      ownerId: characters.ownerId,
      name: characters.name,
      kind: characters.kind,
      archetype: characters.archetype,
      approved: characters.approved,
      createdAt: characters.createdAt,
      ownerName: users.username,
    })
    .from(characters)
    .leftJoin(users, eq(users.id, characters.ownerId))
    .orderBy(desc(characters.createdAt));
  res.json(rows);
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
  const [owner] = await db.select().from(users).where(eq(users.id, c.ownerId));
  if (owner) await patchBalance(owner.discordId, { cash: amount, reason: memo ?? "Admin adjustment" });
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

router.post("/admin/jobs/:job/run", async (req, res): Promise<void> => {
  const job = String(req.params.job);
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

router.get("/admin/stats", async (_req, res): Promise<void> => {
  const [{ count: userCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(users);
  const [{ count: charCount }] = await db.select({ count: sql<number>`count(*)::int` }).from(characters);
  res.json({ userCount, charCount });
});

export default router;
