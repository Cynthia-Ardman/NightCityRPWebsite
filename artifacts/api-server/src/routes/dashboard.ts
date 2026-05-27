import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  db,
  characters,
  characterStatus,
  characterSheets,
  activityEvents,
  fixerNpcs,
  users,
} from "@workspace/db";
import { requireAuth } from "../middlewares/auth";
import { getBalance } from "../lib/unbelievaboat";

const router: IRouter = Router();

router.get("/dashboard/summary", requireAuth, async (req, res): Promise<void> => {
  const myChars = await db.select().from(characters).where(eq(characters.ownerId, req.user!.id));
  const characterIds = myChars.map((c) => c.id);
  let openShops = 0;
  let attendingCount = 0;
  let loaCount = 0;
  if (characterIds.length) {
    const statuses = await db
      .select()
      .from(characterStatus)
      .where(sql`${characterStatus.characterId} = ANY(${characterIds})`);
    for (const s of statuses) {
      if (s.openShop) openShops++;
      if (s.attending) attendingCount++;
      if (s.loa) loaCount++;
    }
  }
  const ub = await getBalance(req.user!.discordId);
  const totalEddies = ub?.total ?? 0;
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)::int` })
    .from(characterSheets)
    .where(eq(characterSheets.status, "pending"));
  const topFixers = await db
    .select({
      fixerId: fixerNpcs.fixerId,
      fixerName: users.username,
      avatarUrl: users.avatarUrl,
      count: sql<number>`count(*)::int`,
    })
    .from(fixerNpcs)
    .leftJoin(users, eq(users.id, fixerNpcs.fixerId))
    .groupBy(fixerNpcs.fixerId, users.username, users.avatarUrl)
    .orderBy(desc(sql`count(*)`))
    .limit(5);
  const recentArrivals = await db
    .select()
    .from(characters)
    .where(eq(characters.kind, "pc"))
    .orderBy(desc(characters.createdAt))
    .limit(5);
  res.json({
    characterCount: myChars.length,
    activeCharacterCount: characterIds.length,
    totalEddies,
    openShops,
    attendingCount,
    loaCount,
    pendingSheets: pending,
    topFixers,
    recentArrivals,
  });
});

router.get("/dashboard/activity", requireAuth, async (_req, res): Promise<void> => {
  const rows = await db.select().from(activityEvents).orderBy(desc(activityEvents.createdAt)).limit(20);
  res.json(rows);
});

export default router;
